import { type Connection, createConnection } from '@sap/hana-client';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, describe, test } from 'vitest';

const _require = createRequire(import.meta.url);

const HANA_HOST = '143.244.150.208';
const HANA_PORT = 39041;
const HANA_USER = 'drizzle';
const HANA_PASS = 'Drizzle123';
const HANA_SCHEMA = 'DRIZZLE';
const HANA_ENCRYPT = false;

const RUN_ID = `${process.pid}_${Date.now()}`;
const PROBE_TABLE = `T_DRIZZLE_HANA_PROBE_${RUN_ID}`;

const CONNECT_TIMEOUT_MS = 10000;
const EXEC_TIMEOUT_MS = 5000;
const RETRY_BACKOFF_MS = 1000;

type ErrClass = 'network' | 'driver' | 'sql' | 'permission' | 'timeout' | 'unknown';
type ProbePhase = 'connect' | 'exec';

interface ProbeResult {
	form: string;
	phase?: ProbePhase;
	accepted: boolean;
	errClass?: ErrClass;
	sqlState?: string;
	errCode?: number;
	message?: string;
	sessionId?: number;
	attempt?: number;
	timedOut?: boolean;
}

interface BehavioralResult {
	form: string;
	expected: string;
	observed: string;
	match: boolean;
	verdict: 'BEHAVIORAL' | 'SYNTAX-ONLY';
	error?: string;
}

const probeResults: Record<string, ProbeResult[]> = {
	'ddl-autocommit': [],
	'per-tx-isolation': [],
	'access-mode': [],
};
const behavioralResults: Record<string, Record<string, BehavioralResult>> = {
	'ddl-autocommit': {},
	'per-tx-isolation': {},
	'access-mode': {},
};
const openConnections: Connection[] = [];

const REDACTABLE = [HANA_HOST, String(HANA_PORT), HANA_USER, HANA_PASS];
function _redactCreds<T>(input: T): T {
	if (input === null || input === undefined) return input;
	if (typeof input === 'string') {
		let out = input;
		for (const cred of REDACTABLE) {
			if (cred && out.includes(cred)) out = out.split(cred).join('[REDACTED]');
		}
		return out as unknown as T;
	}
	if (Array.isArray(input)) {
		return input.map((v) => _redactCreds(v)) as unknown as T;
	}
	if (typeof input === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
			out[k] = _redactCreds(v);
		}
		return out as unknown as T;
	}
	return input;
}

function classifyError(err: Error & { sqlState?: string; code?: number }): ErrClass {
	const ss = err.sqlState ?? '';
	if (ss.startsWith('28')) return 'permission';
	if (ss.startsWith('42')) return 'sql';
	if (ss.startsWith('08')) return 'network';
	if (ss.startsWith('HY')) return 'driver';
	if (err.code === -10709 || err.code === -10807) return 'network';
	if (typeof err.code === 'number' && err.code === 0 && !ss) return 'unknown';
	return 'unknown';
}

function openConn(): Promise<Connection> {
	return new Promise((resolve, reject) => {
		const c = createConnection();
		const t = setTimeout(() => {
			try {
				c.disconnect();
			} catch {
				// ignore
			}
			const err = new Error('connect timeout') as Error & { __timeout?: boolean };
			err.__timeout = true;
			reject(err);
		}, CONNECT_TIMEOUT_MS);
		c.connect({
			host: HANA_HOST,
			port: HANA_PORT,
			user: HANA_USER,
			password: HANA_PASS,
			encrypt: HANA_ENCRYPT,
			communicationTimeout: CONNECT_TIMEOUT_MS,
		}, (err: Error | null) => {
			clearTimeout(t);
			if (err) reject(err);
			else {
				openConnections.push(c);
				resolve(c);
			}
		});
	});
}

function execStmt(c: Connection, stmt: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			const err = new Error('exec timeout') as Error & { __timeout?: boolean };
			err.__timeout = true;
			reject(err);
		}, EXEC_TIMEOUT_MS);
		c.exec(stmt, [], (err: Error | null, res: unknown) => {
			clearTimeout(t);
			if (err) reject(err);
			else resolve(res);
		});
	});
}

interface ProbeOpts {
	autocommit?: boolean;
	setSchema?: boolean;
}

async function runProbeOnce(form: string, opts: ProbeOpts): Promise<ProbeResult> {
	let c: Connection | undefined;
	try {
		c = await openConn();
	} catch (e) {
		const err = e as Error & { __timeout?: boolean; code?: number; sqlState?: string };
		return {
			form,
			phase: 'connect',
			accepted: false,
			errClass: err.__timeout ? 'timeout' : classifyError(err),
			sqlState: err.sqlState,
			errCode: err.code,
			message: _redactCreds(err.message),
			timedOut: !!err.__timeout,
		};
	}

	let sessionId: number | undefined;
	try {
		const ses = (await execStmt(c, 'SELECT CURRENT_CONNECTION FROM DUMMY')) as Array<Record<string, unknown>>;
		const raw = ses?.[0]?.['CURRENT_CONNECTION'];
		if (typeof raw === 'number') sessionId = raw;
		else if (typeof raw === 'string') sessionId = Number(raw);
	} catch {
		// non-fatal — sessionId remains undefined
	}

	if (opts.setSchema !== false) {
		try {
			await execStmt(c, `SET SCHEMA "${HANA_SCHEMA}"`);
		} catch {
			// non-fatal
		}
	}

	if (opts.autocommit === false) {
		try {
			c.setAutoCommit(false);
		} catch {
			// non-fatal
		}
	}

	try {
		await execStmt(c, form);
		return {
			form,
			phase: 'exec',
			accepted: true,
			sessionId,
		};
	} catch (e) {
		const err = e as Error & { __timeout?: boolean; code?: number; sqlState?: string };
		const result: ProbeResult = {
			form,
			phase: 'exec',
			accepted: false,
			errClass: err.__timeout ? 'timeout' : classifyError(err),
			sqlState: err.sqlState,
			errCode: err.code,
			message: _redactCreds(err.message),
			sessionId,
			timedOut: !!err.__timeout,
		};
		return result;
	} finally {
		try {
			if (opts.autocommit === false) c.setAutoCommit(true);
		} catch {
			// ignore
		}
		try {
			c.disconnect();
		} catch {
			// ignore
		}
	}
}

async function runProbe(form: string, opts: ProbeOpts = {}): Promise<ProbeResult> {
	const first = await runProbeOnce(form, opts);
	first.attempt = 1;
	if (!first.accepted && (first.errClass === 'network' || first.errClass === 'timeout')) {
		await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
		const second = await runProbeOnce(form, opts);
		second.attempt = 2;
		return second;
	}
	return first;
}

/**
 * Run a behavioral verification block on a fresh connection.
 * Returns the connection (caller is responsible for cleanup) plus result row(s).
 */
async function behavioralExec(
	stmts: Array<string | { sql: string; autocommit?: boolean; expectError?: boolean }>,
): Promise<{ rows: unknown[]; errors: Error[] }> {
	const c = await openConn();
	const errors: Error[] = [];
	let lastRows: unknown[] = [];
	try {
		await execStmt(c, `SET SCHEMA "${HANA_SCHEMA}"`);
		for (const s of stmts) {
			const sqlText = typeof s === 'string' ? s : s.sql;
			if (typeof s !== 'string' && s.autocommit === false) {
				try {
					c.setAutoCommit(false);
				} catch {
					// ignore
				}
			}
			try {
				const res = await execStmt(c, sqlText);
				if (Array.isArray(res)) lastRows = res;
			} catch (e) {
				errors.push(e as Error);
				if (typeof s === 'object' && !s.expectError) {
					throw e;
				}
			}
		}
		return { rows: lastRows, errors };
	} finally {
		try {
			c.setAutoCommit(true);
		} catch {
			// ignore
		}
		try {
			c.disconnect();
		} catch {
			// ignore
		}
	}
}

describe.sequential('hana runtime probes', () => {
	describe.sequential('DDL autocommit SQL forms', () => {
		const forms = [
			'SET TRANSACTION AUTOCOMMIT DDL ON',
			'SET TRANSACTION AUTOCOMMIT DDL OFF',
			'SET TRANSACTION AUTOCOMMIT_DDL ON',
			`ALTER SESSION SET 'AUTOCOMMIT_DDL' = 'TRUE'`,
			'SET TRANSACTION AUTOCOMMIT ON',
		];

		test.each(forms)('probe %s', async (form) => {
			const r = await runProbe(form, { autocommit: false });
			probeResults['ddl-autocommit']!.push(r);

			if (r.accepted) {
				const tname = `T_DDL_AUTOCOMMIT_BEHAVIORAL_${RUN_ID}_${probeResults['ddl-autocommit']!.length}`;
				try {
					await behavioralExec([
						{ sql: form, autocommit: false },
						{ sql: `CREATE COLUMN TABLE "${tname}" (X INTEGER)`, autocommit: false },
						'ROLLBACK',
					]);
					const probeC = await openConn();
					try {
						await execStmt(probeC, `SET SCHEMA "${HANA_SCHEMA}"`);
						const check = (await execStmt(
							probeC,
							`SELECT TABLE_NAME FROM TABLES WHERE SCHEMA_NAME='${HANA_SCHEMA}' AND TABLE_NAME='${tname}'`,
						)) as Array<Record<string, unknown>>;
						const present = (check?.length ?? 0) > 0;
						behavioralResults['ddl-autocommit']![form] = {
							form,
							expected: 'TABLE PRESENT after ROLLBACK (DDL auto-committed)',
							observed: present ? 'TABLE PRESENT' : 'TABLE ABSENT',
							match: present,
							verdict: present ? 'BEHAVIORAL' : 'SYNTAX-ONLY',
						};
						if (present) {
							try {
								await execStmt(probeC, `DROP TABLE "${tname}"`);
							} catch {
								// ignore
							}
						}
					} finally {
						try {
							probeC.disconnect();
						} catch {
							// ignore
						}
					}
				} catch (e) {
					behavioralResults['ddl-autocommit']![form] = {
						form,
						expected: 'TABLE PRESENT after ROLLBACK',
						observed: 'behavioral pass error',
						match: false,
						verdict: 'SYNTAX-ONLY',
						error: _redactCreds((e as Error).message),
					};
				}
			}
		});
	});

	describe.sequential('per-tx isolation SQL forms', () => {
		const forms = [
			'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
			'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
			'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
			`ALTER SESSION SET 'ISOLATION_LEVEL' = 'READ COMMITTED'`,
			'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED',
		];

		test.each(forms)('probe %s', async (form) => {
			const r = await runProbe(form, { autocommit: false });
			probeResults['per-tx-isolation']!.push(r);

			if (r.accepted) {
				try {
					const obs = await behavioralExec([
						{ sql: form, autocommit: false },
						`SELECT ISOLATION_LEVEL FROM M_TRANSACTIONS WHERE CONNECTION_ID = CURRENT_CONNECTION`,
					]);
					const observed = obs.rows[0] && typeof obs.rows[0] === 'object'
						? String((obs.rows[0] as Record<string, unknown>)['ISOLATION_LEVEL'] ?? '<NULL>')
						: '<NO_ROW>';
					const intent = form.replace(/^SET TRANSACTION ISOLATION LEVEL /i, '')
						.replace(/^ALTER SESSION SET 'ISOLATION_LEVEL' = '|'$/g, '')
						.toUpperCase();
					const match = observed.toUpperCase().includes(intent);
					behavioralResults['per-tx-isolation']![form] = {
						form,
						expected: intent,
						observed,
						match,
						verdict: match ? 'BEHAVIORAL' : 'SYNTAX-ONLY',
					};
				} catch (e) {
					behavioralResults['per-tx-isolation']![form] = {
						form,
						expected: 'observable isolation level matches',
						observed: 'M_TRANSACTIONS query failed (view restricted?)',
						match: false,
						verdict: 'SYNTAX-ONLY',
						error: _redactCreds((e as Error).message),
					};
				}

				if (form.toUpperCase().includes('READ UNCOMMITTED')) {
					behavioralResults['per-tx-isolation']!['__P0_SPEC_CONFLICT'] = {
						form: 'READ UNCOMMITTED accepted',
						expected: 'rejected per pre-driver READ UNCOMMITTED narrowing',
						observed: 'accepted by HANA',
						match: false,
						verdict: 'SYNTAX-ONLY',
					};
				}
			}
		});
	});

	describe.sequential('READ ONLY / READ WRITE access-mode', () => {
		const forms = [
			{ sql: 'SET TRANSACTION READ ONLY', autocommit: false },
			{ sql: 'SET TRANSACTION READ WRITE', autocommit: false },
			{ sql: 'SET TRANSACTION READ ONLY', autocommit: true },
		];

		test.each(forms)('probe $sql (autocommit=$autocommit)', async ({ sql: form, autocommit }) => {
			const r = await runProbe(form, { autocommit });
			(r as ProbeResult & { autocommitMode?: boolean }).message = `[autocommit=${autocommit}] ${r.message ?? ''}`
				.trim();
			probeResults['access-mode']!.push(r);

			if (r.accepted && !autocommit) {
				const probeRow = `R${probeResults['access-mode']!.length}`.padEnd(32, '_').slice(0, 32);
				try {
					const setupC = await openConn();
					try {
						await execStmt(setupC, `SET SCHEMA "${HANA_SCHEMA}"`);
						try {
							await execStmt(
								setupC,
								`CREATE COLUMN TABLE "${PROBE_TABLE}" (ID CHAR(32) PRIMARY KEY)`,
							);
						} catch (e) {
							// table already exists from a prior probe iteration — ignore
							const msg = (e as Error).message.toLowerCase();
							const benign = msg.includes('exists') || msg.includes('already')
								|| msg.includes('duplicate');
							if (!benign) throw e;
						}
					} finally {
						try {
							setupC.disconnect();
						} catch {
							// ignore
						}
					}

					const obs = await behavioralExec([
						{ sql: form, autocommit: false },
						{
							sql: `INSERT INTO "${PROBE_TABLE}" (ID) VALUES ('${probeRow}')`,
							autocommit: false,
							expectError: form.toUpperCase().includes('READ ONLY'),
						},
						'ROLLBACK',
					]);
					const rejected = obs.errors.length > 0;
					const expectReject = form.toUpperCase().includes('READ ONLY');
					const match = expectReject ? rejected : !rejected;
					behavioralResults['access-mode']![`${form} [autocommit=${autocommit}]`] = {
						form: `${form} [autocommit=${autocommit}]`,
						expected: expectReject ? 'INSERT rejected (read-only)' : 'INSERT accepted',
						observed: rejected
							? `INSERT rejected: ${_redactCreds(obs.errors[0]!.message).slice(0, 120)}`
							: 'INSERT accepted',
						match,
						verdict: match ? 'BEHAVIORAL' : 'SYNTAX-ONLY',
					};
				} catch (e) {
					behavioralResults['access-mode']![`${form} [autocommit=${autocommit}]`] = {
						form: `${form} [autocommit=${autocommit}]`,
						expected: 'behavioral attempt',
						observed: 'pass error',
						match: false,
						verdict: 'SYNTAX-ONLY',
						error: _redactCreds((e as Error).message),
					};
				}
			}
		});
	});

	afterAll(async () => {
		// Cleanup probe table residue
		try {
			const c = await openConn();
			try {
				await execStmt(c, `SET SCHEMA "${HANA_SCHEMA}"`);
				const residue = (await execStmt(
					c,
					`SELECT TABLE_NAME FROM TABLES WHERE SCHEMA_NAME='${HANA_SCHEMA}' AND (TABLE_NAME LIKE 'T_DRIZZLE_HANA_PROBE_%' OR TABLE_NAME LIKE 'T_DDL_AUTOCOMMIT_%')`,
				)) as Array<{ TABLE_NAME: string }>;
				for (const row of residue) {
					try {
						await execStmt(c, `DROP TABLE "${row.TABLE_NAME}"`);
					} catch {
						// ignore
					}
				}
			} finally {
				try {
					c.disconnect();
				} catch {
					// ignore
				}
			}
		} catch {
			// ignore cleanup failure
		}

		// Disconnect any stragglers
		for (const c of openConnections) {
			try {
				c.disconnect();
			} catch {
				// ignore
			}
		}

		// Capture reproducibility metadata
		let serverVersion = '<UNKNOWN>';
		try {
			const c = await openConn();
			try {
				const r = (await execStmt(c, 'SELECT VERSION FROM M_DATABASE')) as Array<{ VERSION: string }>;
				serverVersion = r[0]?.VERSION ?? '<UNKNOWN>';
			} finally {
				try {
					c.disconnect();
				} catch {
					// ignore
				}
			}
		} catch {
			// ignore
		}

		const clientPkg = JSON.parse(
			fs.readFileSync(_require.resolve('@sap/hana-client/package.json'), 'utf8'),
		) as { version: string };
		let gitHead = '<UNKNOWN>';
		try {
			gitHead = execSync('git rev-parse HEAD', {
				encoding: 'utf8',
				cwd: path.resolve(process.cwd(), '..'),
			}).trim();
		} catch {
			// ignore
		}

		const meta = {
			captured: new Date().toISOString(),
			hana_server_version: serverVersion,
			hana_client_version: clientPkg.version,
			git_head_sha: gitHead,
			tenant: 'on-prem HANA (single-container)',
			schema: HANA_SCHEMA,
			run_id: RUN_ID,
		};

		const sidecar = _redactCreds({
			meta,
			probeResults,
			behavioralResults,
		});

		const sidecarPath = path.resolve(
			process.cwd(),
			'../.paul/phases/02-driver-fixes/02-03-probe-output.json',
		);
		fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
		const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
		fs.writeFileSync(sidecarPath, serialized, 'utf8');

		const sha = crypto.createHash('sha256').update(serialized).digest('hex');
		// Print compact summary for manual runner
		const summary = {
			sidecar: sidecarPath,
			sha256: sha,
			counts: {
				'ddl-autocommit': probeResults['ddl-autocommit']!.length,
				'per-tx-isolation': probeResults['per-tx-isolation']!.length,
				'access-mode': probeResults['access-mode']!.length,
			},
			distinctSessions: new Set(
				Object.values(probeResults)
					.flat()
					.map((r) => r.sessionId)
					.filter((s): s is number => typeof s === 'number'),
			).size,
		};
		// eslint-disable-next-line no-console
		console.log('PROBE_SIDECAR_SUMMARY', JSON.stringify(_redactCreds(summary)));
	}, 60000);
});
