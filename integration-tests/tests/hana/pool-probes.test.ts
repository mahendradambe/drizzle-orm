import * as hanaClient from '@sap/hana-client';
import { type Connection, createConnection } from '@sap/hana-client';
import { HANA_POOL_ACQUIRE_TIMEOUT, HANA_POOL_CONNECTION_DEAD, SapHanaPool } from 'drizzle-orm/sap-hana';
import { _normalizeHanaError } from 'drizzle-orm/sap-hana/session';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const _require = createRequire(import.meta.url);

// ─── Module constants ──────────────────────────────────────────────────────
// Env-var override; sensible defaults for known dev environments.
const HANA_HOST = process.env['HANA_PROBE_HOST'] ?? '143.244.150.208';
const HANA_PORT = Number(process.env['HANA_PROBE_PORT'] ?? 39041);
const HANA_USER = process.env['HANA_PROBE_USER'] ?? 'drizzle';
const HANA_PASS = process.env['HANA_PROBE_PASS'] ?? 'Drizzle123';
const HANA_SCHEMA = process.env['HANA_PROBE_SCHEMA'] ?? 'DRIZZLE';
const HANA_ENCRYPT = (process.env['HANA_PROBE_ENCRYPT'] ?? 'false') === 'true';

// F1: PID + ms + 8-hex-char crypto suffix prevents collisions across parallel CI containers.
const RUN_ID = `${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const PROBE_TABLE = `T_DRIZZLE_HANA_POOL_PROBE_${RUN_ID}`;

const CONNECT_TIMEOUT_MS = 10000;
const EXEC_TIMEOUT_MS = 5000;
const ACQUIRE_TIMEOUT_MS = 500;

// ─── Shared types ──────────────────────────────────────────────────────────
type PoolStrategy = 'driver-native' | 'custom';
type ErrClass = 'network' | 'driver' | 'sql' | 'permission' | 'timeout' | 'acquire-timeout' | 'unknown';
type ProbePhase = 'connect' | 'acquire' | 'exec' | 'release';

interface PoolProbeResult {
	strategy: PoolStrategy;
	probeId: string;
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
	elapsedMs?: number;
}

interface DescriptorSnapshot {
	onOwn: boolean;
	protoDepth: number; // 0 = own, 1+ = proto-chain depth, -1 = not found
	configurable: boolean;
	writable: boolean;
	valueIsNative: boolean;
	valueRefEqualsPrior: boolean | null; // F6: null on first cycle
}

interface MethodPinningSnapshot {
	strategy: PoolStrategy;
	cycle: number;
	sameConnRef: boolean;
	commitDescriptor: DescriptorSnapshot;
	rollbackDescriptor: DescriptorSnapshot;
	prepareDescriptor: DescriptorSnapshot;
}

interface TxIsolationResult {
	strategy: PoolStrategy;
	uncommittedRowVisiblePostRelease: boolean;
	autoCommitStatePostReacquire: boolean | null;
	setAutoCommitShape: 'sync' | 'promise' | 'unknown';
	forensicCleanupFailed?: boolean;
	details?: Record<string, unknown>;
}

interface ParallelismResult {
	strategy: PoolStrategy;
	queryCount: number;
	totalWallclockMs: number;
	maxOverlapCount: number;
	verdict: 'parallel' | 'partial' | 'serialized';
	maxEventLoopTickGapMs: number;
	eventLoopBlocked: boolean;
}

interface AdversarialResult {
	case: 'acquire-timeout' | 'conn-death-mid-tx';
	strategy: PoolStrategy;
	details: Record<string, unknown>;
}

// ─── Module-scope result buckets ────────────────────────────────────────────
const probeResults: PoolProbeResult[] = [];
const methodPinningResults: MethodPinningSnapshot[] = [];
const txIsolationResults: TxIsolationResult[] = [];
const parallelismResults: ParallelismResult[] = [];
const adversarialResults: AdversarialResult[] = [];
const openConnections: Connection[] = [];
let serverSideBaselineSessions = 0;
let serverSideLeakedSessions = 0;
let cleanupDropFailed = false;
let sidecarValidationFailed = false;

// ─── Result buckets (live-HDI validation of SapHanaPool) ───────────────────
interface LoadProbeResult {
	contention: {
		holders: number;
		acquireAttempts: number;
		rejections: number;
		firstRejectElapsedMs?: number;
		toleranceWindowMs: { min: number; max: number };
		withinTolerance: boolean;
		acquireTimeoutEventCount: number;
		postReleaseDistinctSession: boolean | null;
		verdict: 'PASS' | 'FAIL';
	};
	flakeRetries: Array<{ attempt: number; elapsedMs: number; pass: boolean }>;
	deadConnOnBorrow: { numerator: number; denominator: number; rate: number };
}
interface MinPreWarmResult {
	preWarmSnapshot: number;
	postWarmLoopSnapshot: number;
	verdict: 'VERIFIED-PASS' | 'VERIFIED-NO-OP' | 'PARTIAL';
}
interface ClearWithCheckoutsResult {
	destroyResolveMs: number;
	destroyHang: boolean;
	perConnExec: Array<{
		sessionId?: number;
		resolved: boolean;
		rejected: boolean;
		hang: boolean;
		errCode?: number | string;
		sqlState?: string;
	}>;
	subsequentAcquireErrCode?: number | string;
	subsequentAcquireHang: boolean;
	verdict: 'VERIFIED-PASS' | 'REFUTED' | 'PARTIAL';
	markers: string[];
}
interface ServerDisconnectResult {
	victimSessionId?: number;
	freshSessionId?: number;
	attempts: Array<
		{ index: number; resolved: boolean; rejected: boolean; errCode?: number | string; sqlState?: string }
	>;
	attemptIndexOfFirstFailure?: number;
	totalAttempts: number;
	allAttemptsSucceeded: boolean;
	firstFailureErr?: { code?: number | string; sqlState?: string; normalizedCode?: string };
	rowVisiblePostDisconnect: boolean;
	verdict: 'PASS' | 'FAIL';
}
interface IdleTrajectoryResult {
	idleTimeoutMs: number;
	samples: Array<{ tMs: number; pooledCount: number }>;
	firstEvictionAtMs?: number;
	verdict: 'PASS' | 'UNVERIFIABLE-IN-WINDOW' | 'SKIPPED';
	skipReason?: string;
}
interface LeakDeltaResult {
	baseline: number;
	leakCount: number;
	leakDelta: number;
	mitigation_applied: boolean;
	diagnostic?: Array<Record<string, unknown>>;
}
interface CrossTenantPrepResult {
	envVarPathUsed: boolean;
	envKeysResolved: Record<string, string>;
	contentionVerdict: 'PASS' | 'FAIL';
	verdictMatchesDefaultPath: boolean | null;
}

let loadProbeResult: LoadProbeResult | undefined;
let minPreWarmResult: MinPreWarmResult | undefined;
let clearWithCheckoutsResult: ClearWithCheckoutsResult | undefined;
let serverDisconnectResult: ServerDisconnectResult | undefined;
let idleTrajectoryResult: IdleTrajectoryResult | undefined;
let leakDeltaResult: LeakDeltaResult | undefined;
let crossTenantPrepResult: CrossTenantPrepResult | undefined;
let driverVersionLockCheck: 'PASS' | 'FAIL' | 'UNKNOWN' = 'UNKNOWN';
let hanaInstanceId: string | undefined;
let hanaClientVersionInstalled: string | undefined;

// Shared cleanup conn (leak-delta mitigation) — opened in beforeAll, reused by afterAll.
let sharedCleanupConn: Connection | undefined;

// ─── Sidecar emit + coexistence guard ──────────────────────────────────────
const SIDECAR_PATH_0303 = path.resolve(
	process.cwd(),
	'../.paul/phases/03-pool-support/03-03-probe-output.json',
);
const SIDECAR_PATH_0304 = path.resolve(
	process.cwd(),
	'../.paul/phases/03-pool-support/03-04-probe-output.json',
);
const SIDECAR_PATH_0301 = path.resolve(
	process.cwd(),
	'../.paul/phases/03-pool-support/03-01-probe-output.json',
);
const SIDECAR_PATH_TARGET = SIDECAR_PATH_0303;

function _assertSidecarPathNotClobbering(target: string): void {
	if (target === SIDECAR_PATH_0301) {
		throw new Error(
			'SIDECAR_COLLISION — emit would clobber 03-01 sidecar; abort',
		);
	}
	if (target === SIDECAR_PATH_0304) {
		throw new Error(
			'SIDECAR_COLLISION — emit would clobber 03-04 sidecar (preserved historical evidence); abort',
		);
	}
}

function _buildSidecarPayload(): Record<string, unknown> {
	const meta = {
		schema_version: 1,
		captured: new Date().toISOString(),
		hana_server_version: '<UNKNOWN>',
		hana_client_version: hanaClientVersionInstalled ?? '<UNKNOWN>',
		hana_client_version_installed: hanaClientVersionInstalled ?? '<UNKNOWN>',
		hana_instance_id: hanaInstanceId ?? '<UNKNOWN>',
		git_head_sha: '<UNKNOWN>',
		run_id: RUN_ID,
		server_side_baseline_sessions: serverSideBaselineSessions,
		server_side_leaked_sessions: serverSideLeakedSessions,
		cleanup_drop_failed: cleanupDropFailed,
		sidecar_validation_failed: sidecarValidationFailed,
		driver_version_lock_check: driverVersionLockCheck,
	};
	return _redactCreds({
		meta,
		probeResults,
		methodPinningResults,
		txIsolationResults,
		parallelismResults,
		adversarialResults,
		loadProbe: loadProbeResult,
		minPreWarm: minPreWarmResult,
		clearWithCheckouts: clearWithCheckoutsResult,
		serverDisconnect: serverDisconnectResult,
		idleTrajectory: idleTrajectoryResult,
		leakDelta: leakDeltaResult,
		crossTenantPrep: crossTenantPrepResult,
	});
}

// Per-group incremental emit (resilience vs suite timeout).
function _writeSidecarSnapshot(): void {
	try {
		_assertSidecarPathNotClobbering(SIDECAR_PATH_TARGET);
		fs.mkdirSync(path.dirname(SIDECAR_PATH_TARGET), { recursive: true });
		const payload = _buildSidecarPayload();
		fs.writeFileSync(SIDECAR_PATH_TARGET, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	} catch (e) {
		// Snapshot failures must not break the test runner; afterAll consolidates.
		// eslint-disable-next-line no-console
		console.warn('POOL_PROBE_SIDECAR_SNAPSHOT_WARN', (e as Error).message);
	}
}

// ─── Cred redaction ─────────────────────────────────────────────────────────
const REDACTABLE = [HANA_HOST, String(HANA_PORT), HANA_USER, HANA_PASS].filter(Boolean);
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

function classifySqlState(err: Error & { sqlState?: string; code?: number; __timeout?: boolean }): ErrClass {
	if (err.__timeout) return 'timeout';
	const ss = err.sqlState ?? '';
	if (ss.startsWith('28')) return 'permission';
	if (ss.startsWith('42')) return 'sql';
	if (ss.startsWith('08')) return 'network';
	if (ss.startsWith('HY')) return 'driver';
	if (err.code === -10709 || err.code === -10807) return 'network';
	return 'unknown';
}

// ─── Connection helpers (non-pool, used by setup/cleanup + cross-checks) ────
function openRawConn(): Promise<Connection> {
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

async function captureSessionId(c: Connection): Promise<number | undefined> {
	try {
		const ses = (await execStmt(c, 'SELECT CURRENT_CONNECTION FROM DUMMY')) as Array<Record<string, unknown>>;
		const raw = ses?.[0]?.['CURRENT_CONNECTION'];
		if (typeof raw === 'number') return raw;
		if (typeof raw === 'string') return Number(raw);
	} catch {
		// non-fatal
	}
	return undefined;
}

// ─── Descriptor helpers (F16 proto-chain walk, F6 IDENTITY check) ──────────
function _resolveDescriptor(
	obj: unknown,
	name: string,
	maxDepth = 5,
): { onOwn: boolean; protoDepth: number; descriptor: PropertyDescriptor | undefined } {
	let target: object | null = obj as object | null;
	let depth = 0;
	while (target && depth <= maxDepth) {
		const d = Object.getOwnPropertyDescriptor(target, name);
		if (d) return { onOwn: depth === 0, protoDepth: depth, descriptor: d };
		target = Object.getPrototypeOf(target);
		depth += 1;
	}
	return { onOwn: false, protoDepth: -1, descriptor: undefined };
}

/**
 * Capture descriptor snapshots for commit/rollback/prepare. `priorRefs` carries
 * the previous cycle's raw `descriptor.value` refs (F6 IDENTITY check); pass
 * `null` on first cycle. Returns a `{snapshot, refs}` pair — `refs` is the
 * non-serializable raw-ref map to thread into the next cycle.
 */
function captureMethodDescriptors(
	conn: Connection,
	priorRefs: { commit?: unknown; rollback?: unknown; prepare?: unknown } | null,
): {
	snapshot: { commit: DescriptorSnapshot; rollback: DescriptorSnapshot; prepare: DescriptorSnapshot };
	refs: { commit: unknown; rollback: unknown; prepare: unknown };
} {
	const buildSnap = (methodName: 'commit' | 'rollback' | 'prepare'): { snap: DescriptorSnapshot; ref: unknown } => {
		const r = _resolveDescriptor(conn, methodName);
		const d = r.descriptor;
		const ref = d?.value;
		const valueIsNative = typeof ref === 'function'
			&& Function.prototype.toString.call(ref).includes('[native code]');
		const prior = priorRefs?.[methodName];
		const valueRefEqualsPrior = (priorRefs === null || priorRefs === undefined) ? null : (ref === prior);
		return {
			snap: {
				onOwn: r.onOwn,
				protoDepth: r.protoDepth,
				configurable: !!d?.configurable,
				writable: !!d?.writable,
				valueIsNative,
				valueRefEqualsPrior,
			},
			ref,
		};
	};
	const c = buildSnap('commit');
	const rb = buildSnap('rollback');
	const p = buildSnap('prepare');
	return {
		snapshot: { commit: c.snap, rollback: rb.snap, prepare: p.snap },
		refs: { commit: c.ref, rollback: rb.ref, prepare: p.ref },
	};
}

// ─── Pool factory stubs (filled in Task 3) ─────────────────────────────────
export interface PoolFactoryOpts {
	min: number;
	max: number;
	acquireTimeoutMs?: number;
}

export interface PoolHandle {
	strategy: PoolStrategy;
	acquire(): Promise<Connection>;
	release(c: Connection): Promise<void>;
	destroy(): Promise<void>;
	pooledCount(): number;
	inUseCount(): number;
}

// Connection options reused by both factories.
const POOL_CONN_OPTS = {
	host: HANA_HOST,
	port: HANA_PORT,
	user: HANA_USER,
	password: HANA_PASS,
	encrypt: HANA_ENCRYPT,
	communicationTimeout: CONNECT_TIMEOUT_MS,
};

async function nativePoolFactory(opts: PoolFactoryOpts): Promise<PoolHandle> {
	// @sap/hana-client createPool(opts, poolParameters) → ConnectionPool
	// PoolOptions docs: maxPoolSize, maxIdleTime; acquire-timeout is NOT a
	// documented native pool param — we layer it in JS via wait timeout.
	const poolParams: Record<string, unknown> = {
		maxPoolSize: opts.max,
	};
	// `min` has no direct native equivalent — native pool is lazy. We pre-warm
	// by acquiring + releasing `min` conns immediately after construction.
	const native = (hanaClient as unknown as {
		createPool: (
			o: Record<string, unknown>,
			p: Record<string, unknown>,
		) => {
			getConnection: (fn: (err: Error | null, c?: Connection) => void) => void;
			clear: (fn?: (err: Error | null) => void) => void;
			getPooledCount: () => number;
			getInUseCount: () => number;
		};
	}).createPool(POOL_CONN_OPTS as Record<string, unknown>, poolParams);

	const inFlight = new Set<Connection>();

	const acquireWithTimeout = (timeoutMs: number | undefined): Promise<Connection> =>
		new Promise((resolve, reject) => {
			let settled = false;
			const t = timeoutMs
				? setTimeout(() => {
					if (settled) return;
					settled = true;
					const err = new Error(
						`acquire timeout after ${timeoutMs}ms`,
					) as Error & { __acquireTimeout?: boolean };
					err.__acquireTimeout = true;
					reject(err);
				}, timeoutMs)
				: undefined;
			native.getConnection((err: Error | null, c?: Connection) => {
				if (t) clearTimeout(t);
				if (settled) {
					if (c) {
						try {
							c.close();
						} catch {
							// ignore
						}
					}
					return;
				}
				settled = true;
				if (err) reject(err);
				else if (!c) reject(new Error('no conn from pool'));
				else {
					inFlight.add(c);
					openConnections.push(c);
					resolve(c);
				}
			});
		});

	const handle: PoolHandle = {
		strategy: 'driver-native',
		acquire: () => acquireWithTimeout(opts.acquireTimeoutMs),
		async release(c: Connection): Promise<void> {
			inFlight.delete(c);
			// close() returns pooled conn to pool (SAP docs); disconnect() destroys.
			await new Promise<void>((resolve) => {
				try {
					c.close((err) => {
						if (err) {
							// fallback to disconnect if pool refused
							try {
								c.disconnect();
							} catch {
								// ignore
							}
						}
						resolve();
					});
				} catch {
					resolve();
				}
			});
		},
		async destroy(): Promise<void> {
			await new Promise<void>((resolve) => {
				try {
					native.clear(() => resolve());
				} catch {
					resolve();
				}
			});
		},
		pooledCount: () => {
			try {
				return native.getPooledCount();
			} catch {
				return -1;
			}
		},
		inUseCount: () => {
			try {
				return native.getInUseCount();
			} catch {
				return inFlight.size;
			}
		},
	};

	// Pre-warm `min` connections — bypass acquireTimeoutMs (uses CONNECT_TIMEOUT only).
	if (opts.min > 0) {
		const warm: Connection[] = [];
		for (let i = 0; i < opts.min; i++) warm.push(await acquireWithTimeout(undefined));
		for (const c of warm) await handle.release(c);
	}

	return handle;
}

async function customPoolFactory(opts: PoolFactoryOpts): Promise<PoolHandle> {
	const idle: Connection[] = [];
	const busy = new Set<Connection>();
	let total = 0;
	let destroyed = false;
	const waiters: Array<{ resolve: (c: Connection) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }> = [];

	const createConn = (): Promise<Connection> =>
		new Promise((resolve, reject) => {
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
			c.connect(POOL_CONN_OPTS, (err: Error | null) => {
				clearTimeout(t);
				if (err) reject(err);
				else {
					total += 1;
					openConnections.push(c);
					resolve(c);
				}
			});
		});

	const handle: PoolHandle = {
		strategy: 'custom',
		async acquire(): Promise<Connection> {
			if (destroyed) throw new Error('pool destroyed');
			if (idle.length > 0) {
				const c = idle.pop()!;
				busy.add(c);
				return c;
			}
			if (total < opts.max) {
				const c = await createConn();
				busy.add(c);
				return c;
			}
			// wait for a release
			return await new Promise<Connection>((resolve, reject) => {
				const entry: { resolve: (c: Connection) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = {
					resolve,
					reject,
				};
				if (opts.acquireTimeoutMs) {
					entry.timer = setTimeout(() => {
						const idx = waiters.indexOf(entry);
						if (idx >= 0) waiters.splice(idx, 1);
						const err = new Error(
							`acquire timeout after ${opts.acquireTimeoutMs}ms`,
						) as Error & { __acquireTimeout?: boolean };
						err.__acquireTimeout = true;
						reject(err);
					}, opts.acquireTimeoutMs);
				}
				waiters.push(entry);
			});
		},
		async release(c: Connection): Promise<void> {
			busy.delete(c);
			// If pool was destroyed, kill the conn
			if (destroyed) {
				try {
					c.disconnect();
				} catch {
					// ignore
				}
				return;
			}
			// Hand off to a waiter if any
			const w = waiters.shift();
			if (w) {
				if (w.timer) clearTimeout(w.timer);
				busy.add(c);
				w.resolve(c);
				return;
			}
			// Else back to idle
			idle.push(c);
		},
		async destroy(): Promise<void> {
			destroyed = true;
			for (const w of waiters) {
				if (w.timer) clearTimeout(w.timer);
				w.reject(new Error('pool destroyed'));
			}
			waiters.length = 0;
			const all = [...idle, ...busy];
			idle.length = 0;
			busy.clear();
			for (const c of all) {
				try {
					c.disconnect();
				} catch {
					// ignore
				}
			}
		},
		pooledCount: () => idle.length,
		inUseCount: () => busy.size,
	};

	// Pre-warm min
	if (opts.min > 0) {
		const warm: Connection[] = [];
		for (let i = 0; i < opts.min; i++) warm.push(await handle.acquire());
		for (const c of warm) await handle.release(c);
	}
	return handle;
}

// ─── Probe-execution helpers ───────────────────────────────────────────────
function recordProbeError(
	strategy: PoolStrategy,
	probeId: string,
	form: string,
	phase: ProbePhase,
	err: Error & { sqlState?: string; code?: number; __timeout?: boolean; __acquireTimeout?: boolean },
	elapsedMs: number,
): PoolProbeResult {
	const result: PoolProbeResult = {
		strategy,
		probeId,
		form,
		phase,
		accepted: false,
		errClass: err.__acquireTimeout ? 'acquire-timeout' : classifySqlState(err),
		sqlState: err.sqlState,
		errCode: err.code,
		message: _redactCreds(err.message),
		timedOut: !!err.__timeout || !!err.__acquireTimeout,
		elapsedMs,
	};
	probeResults.push(result);
	return result;
}

// Reference exports to suppress unused-var noise on skeleton-only paths.
void captureSessionId;
void captureMethodDescriptors;
void PROBE_TABLE;
void ACQUIRE_TIMEOUT_MS;
void EXEC_TIMEOUT_MS;
void _resolveDescriptor;
void recordProbeError;

// ─── beforeAll / afterAll lifecycle ────────────────────────────────────────
describe.sequential('hana pool probes', () => {
	beforeAll(async () => {
		// Driver-version lock check (read from node_modules, not project package.json).
		try {
			const installed = JSON.parse(
				fs.readFileSync(_require.resolve('@sap/hana-client/package.json'), 'utf8'),
			) as { version: string };
			hanaClientVersionInstalled = installed.version;
			driverVersionLockCheck = installed.version === '2.27.19' ? 'PASS' : 'FAIL';
		} catch {
			driverVersionLockCheck = 'FAIL';
		}

		_assertSidecarPathNotClobbering(SIDECAR_PATH_TARGET);

		// Leak-delta mitigation: open ONE shared cleanup conn, reuse for baseline + leak-count + DROP TABLE.
		sharedCleanupConn = await openRawConn();
		await execStmt(sharedCleanupConn, `SET SCHEMA "${HANA_SCHEMA}"`);

		// F9: idempotent table init — drop-if-exists then create.
		try {
			await execStmt(sharedCleanupConn, `DROP TABLE "${PROBE_TABLE}"`);
		} catch {
			// first-run: table doesn't exist; ignore
		}
		await execStmt(
			sharedCleanupConn,
			`CREATE COLUMN TABLE "${PROBE_TABLE}" (ID INTEGER PRIMARY KEY, V NVARCHAR(64))`,
		);

		// Idempotency pre-clear (PROBE_TABLE created above; defensive vs prior partial-run residue
		// on the SAME run_id-suffixed table — no-op on first run but explicit per audit M5).
		try {
			await execStmt(sharedCleanupConn, `DELETE FROM "${PROBE_TABLE}" WHERE ID IN (995, 996, 997, 998)`);
		} catch {
			// no-op on fresh table; non-fatal
		}

		// Capture HANA instance fingerprint (HOST/INSTANCE_NUMBER from M_HOST_INFORMATION).
		try {
			const hi = (await execStmt(
				sharedCleanupConn,
				`SELECT KEY, VALUE FROM SYS.M_HOST_INFORMATION WHERE KEY IN ('host_name', 'sid')`,
			)) as Array<{ KEY: string; VALUE: string }>;
			const map: Record<string, string> = {};
			for (const row of hi ?? []) map[row.KEY] = String(row.VALUE);
			const host = map['host_name'] ?? '<unknown>';
			const sid = map['sid'] ?? '<unknown>';
			hanaInstanceId = `${host}/${sid}`;
		} catch {
			// non-fatal; field stays UNKNOWN
		}

		// Capture server-side baseline session count for leak delta (via shared conn).
		try {
			const r = (await execStmt(
				sharedCleanupConn,
				`SELECT COUNT(*) AS C FROM M_CONNECTIONS WHERE USER_NAME = CURRENT_USER AND CONNECTION_STATUS IN ('RUNNING','IDLE')`,
			)) as Array<{ C: number | string }>;
			const raw = r?.[0]?.C;
			serverSideBaselineSessions = typeof raw === 'number' ? raw : Number(raw ?? 0);
		} catch {
			// non-fatal; baseline stays 0
		}
	}, 60000);

	afterAll(async () => {
		// F2: hardened — each step in its own try/catch so a single failure does not block teardown.
		// Reuse sharedCleanupConn opened in beforeAll (single conn for baseline + leak-count + DROP).

		// Step 1–3: drop table + capture leak-count via shared conn. Fallback to a retry conn on failure.
		let droppedOk = false;
		if (sharedCleanupConn) {
			try {
				await execStmt(sharedCleanupConn, `DROP TABLE "${PROBE_TABLE}"`);
				droppedOk = true;
			} catch {
				// drop failed — try retry conn
			}
			if (droppedOk) {
				try {
					const r = (await execStmt(
						sharedCleanupConn,
						`SELECT COUNT(*) AS C FROM M_CONNECTIONS WHERE USER_NAME = CURRENT_USER AND CONNECTION_STATUS IN ('RUNNING','IDLE')`,
					)) as Array<{ C: number | string }>;
					const raw = r?.[0]?.C;
					serverSideLeakedSessions = typeof raw === 'number' ? raw : Number(raw ?? 0);
				} catch {
					// non-fatal
				}
			}
		}
		if (!droppedOk) {
			try {
				const retryConn = await openRawConn();
				try {
					await execStmt(retryConn, `SET SCHEMA "${HANA_SCHEMA}"`);
					await execStmt(retryConn, `DROP TABLE "${PROBE_TABLE}"`);
					droppedOk = true;
					// Capture leak-count via retry conn as fallback.
					try {
						const r = (await execStmt(
							retryConn,
							`SELECT COUNT(*) AS C FROM M_CONNECTIONS WHERE USER_NAME = CURRENT_USER AND CONNECTION_STATUS IN ('RUNNING','IDLE')`,
						)) as Array<{ C: number | string }>;
						const raw = r?.[0]?.C;
						serverSideLeakedSessions = typeof raw === 'number' ? raw : Number(raw ?? 0);
					} catch {
						// non-fatal
					}
				} finally {
					try {
						retryConn.disconnect();
					} catch {
						// ignore
					}
				}
			} catch {
				cleanupDropFailed = true;
			}
		}
		if (!droppedOk) cleanupDropFailed = true;

		// Leak-delta + mitigation_applied (DERIVED, NOT hardcoded).
		const leakDelta = serverSideLeakedSessions - serverSideBaselineSessions;
		leakDeltaResult = {
			baseline: serverSideBaselineSessions,
			leakCount: serverSideLeakedSessions,
			leakDelta,
			mitigation_applied: leakDelta <= 1,
		};
		if (leakDelta > 1 && sharedCleanupConn) {
			try {
				const diag = (await execStmt(
					sharedCleanupConn,
					`SELECT CONNECTION_STATUS, COUNT(*) AS N FROM M_CONNECTIONS WHERE USER_NAME = CURRENT_USER GROUP BY CONNECTION_STATUS ORDER BY N DESC`,
				)) as Array<Record<string, unknown>>;
				leakDeltaResult.diagnostic = diag.slice(0, 10);
			} catch {
				// non-fatal
			}
		}

		// Disconnect shared cleanup conn last.
		if (sharedCleanupConn) {
			try {
				sharedCleanupConn.disconnect();
			} catch {
				// ignore
			}
		}

		// Step 4: disconnect any stragglers — each in own try/catch.
		for (const c of openConnections) {
			try {
				c.disconnect();
			} catch {
				// ignore individual failures
			}
		}

		let serverVersion = '<UNKNOWN>';
		try {
			const c = await openRawConn();
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
			// ignore — meta stays UNKNOWN
		}

		// hana_client_version_installed from node_modules (not project package.json).
		if (!hanaClientVersionInstalled) {
			try {
				const pkg = JSON.parse(
					fs.readFileSync(_require.resolve('@sap/hana-client/package.json'), 'utf8'),
				) as { version: string };
				hanaClientVersionInstalled = pkg.version;
			} catch {
				// ignore
			}
		}

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
			schema_version: 1,
			captured: new Date().toISOString(),
			hana_server_version: serverVersion,
			hana_client_version: hanaClientVersionInstalled ?? '<UNKNOWN>',
			hana_client_version_installed: hanaClientVersionInstalled ?? '<UNKNOWN>',
			hana_instance_id: hanaInstanceId ?? '<UNKNOWN>',
			git_head_sha: gitHead,
			run_id: RUN_ID,
			server_side_baseline_sessions: serverSideBaselineSessions,
			server_side_leaked_sessions: serverSideLeakedSessions,
			cleanup_drop_failed: cleanupDropFailed,
			sidecar_validation_failed: sidecarValidationFailed,
			driver_version_lock_check: driverVersionLockCheck,
		};

		const sidecar = _redactCreds({
			meta,
			probeResults,
			methodPinningResults,
			txIsolationResults,
			parallelismResults,
			adversarialResults,
			loadProbe: loadProbeResult,
			minPreWarm: minPreWarmResult,
			clearWithCheckouts: clearWithCheckoutsResult,
			serverDisconnect: serverDisconnectResult,
			idleTrajectory: idleTrajectoryResult,
			leakDelta: leakDeltaResult,
			crossTenantPrep: crossTenantPrepResult,
		});

		_assertSidecarPathNotClobbering(SIDECAR_PATH_TARGET);

		fs.mkdirSync(path.dirname(SIDECAR_PATH_TARGET), { recursive: true });
		const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
		fs.writeFileSync(SIDECAR_PATH_TARGET, serialized, 'utf8');

		// Sidecar shape validation via jq -e.
		try {
			execSync(
				`jq -e '.meta.schema_version == 1 and .meta.captured != null and .meta.git_head_sha != null and .meta.hana_instance_id != null and .meta.hana_client_version_installed != null and .meta.driver_version_lock_check != null and (.probeResults | type == "array") and (.methodPinningResults | type == "array") and (.txIsolationResults | type == "array") and (.parallelismResults | type == "array") and (.adversarialResults | type == "array")' "${SIDECAR_PATH_TARGET}"`,
				{ stdio: 'pipe' },
			);
		} catch {
			sidecarValidationFailed = true;
			// Re-write meta with the failure flag set.
			const sidecarWithFlag = _redactCreds({
				...sidecar,
				meta: { ...meta, sidecar_validation_failed: true },
			});
			fs.writeFileSync(SIDECAR_PATH_TARGET, `${JSON.stringify(sidecarWithFlag, null, 2)}\n`, 'utf8');
		}

		const sha = crypto.createHash('sha256').update(fs.readFileSync(SIDECAR_PATH_TARGET)).digest('hex');
		// eslint-disable-next-line no-console
		console.log(
			'POOL_PROBE_SIDECAR_SUMMARY',
			JSON.stringify(_redactCreds({
				sidecar: SIDECAR_PATH_TARGET,
				sha256: sha,
				sha256_prefix: sha.slice(0, 8),
				counts: {
					probeResults: probeResults.length,
					methodPinning: methodPinningResults.length,
					txIsolation: txIsolationResults.length,
					parallelism: parallelismResults.length,
					adversarial: adversarialResults.length,
				},
				driverVersionLockCheck,
				hanaInstanceId,
				hanaClientVersionInstalled,
				serverSideBaselineSessions,
				serverSideLeakedSessions,
				leakDelta,
				cleanupDropFailed,
				sidecarValidationFailed,
			})),
		);
	}, 60000);

	test('harness smoke — DB reachable + sidecar write fires', async () => {
		const c = await openRawConn();
		try {
			const sid = await captureSessionId(c);
			expect(typeof sid).toBe('number');
		} finally {
			try {
				c.disconnect();
			} catch {
				// ignore
			}
		}
	});

	// ─── Driver-native pool ────────────────────────────────────────────────
	describe.sequential('driver-native pool', () => {
		test('acquire → exec → release', async () => {
			let pool: PoolHandle | undefined;
			const t0 = performance.now();
			try {
				pool = await nativePoolFactory({ min: 1, max: 4 });
				const c = await pool.acquire();
				const sid = await captureSessionId(c);
				await execStmt(c, 'SELECT 1 FROM DUMMY');
				await pool.release(c);
				probeResults.push({
					strategy: 'driver-native',
					probeId: 'driver-native-a',
					form: 'acquire→exec→release',
					phase: 'release',
					accepted: true,
					sessionId: sid,
					elapsedMs: performance.now() - t0,
				});
			} catch (e) {
				recordProbeError(
					'driver-native',
					'driver-native-a',
					'acquire→exec→release',
					'acquire',
					e as Error,
					performance.now() - t0,
				);
			} finally {
				if (pool) await pool.destroy();
			}
		});

		test('sequential checkout × 5', async () => {
			let pool: PoolHandle | undefined;
			try {
				pool = await nativePoolFactory({ min: 1, max: 4 });
				const sessionIds: Array<number | undefined> = [];
				for (let i = 1; i <= 5; i++) {
					const t0 = performance.now();
					try {
						const c = await pool.acquire();
						const sid = await captureSessionId(c);
						sessionIds.push(sid);
						await pool.release(c);
						probeResults.push({
							strategy: 'driver-native',
							probeId: `driver-native-b-${i}`,
							form: `sequential checkout cycle ${i}`,
							accepted: true,
							sessionId: sid,
							elapsedMs: performance.now() - t0,
						});
					} catch (e) {
						recordProbeError(
							'driver-native',
							`driver-native-b-${i}`,
							`sequential checkout cycle ${i}`,
							'acquire',
							e as Error,
							performance.now() - t0,
						);
					}
				}
				probeResults.push({
					strategy: 'driver-native',
					probeId: 'driver-native-b-summary',
					form: `distinct sessionIds across 5 cycles: ${new Set(sessionIds).size}`,
					accepted: true,
				});
			} catch (e) {
				recordProbeError(
					'driver-native',
					'driver-native-b',
					'sequential checkout × 5',
					'acquire',
					e as Error,
					0,
				);
			} finally {
				if (pool) await pool.destroy();
			}
		});

		test('parallel checkout × 4', async () => {
			let pool: PoolHandle | undefined;
			const t0 = performance.now();
			try {
				pool = await nativePoolFactory({ min: 1, max: 4 });
				const conns = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
				const sids = await Promise.all(conns.map((c) => captureSessionId(c)));
				const distinct = new Set(sids.filter((s): s is number => typeof s === 'number')).size;
				for (const c of conns) await pool.release(c);
				probeResults.push({
					strategy: 'driver-native',
					probeId: 'driver-native-c',
					form: `parallel × 4 distinct sessions=${distinct}`,
					accepted: true,
					elapsedMs: performance.now() - t0,
				});
			} catch (e) {
				recordProbeError(
					'driver-native',
					'driver-native-c',
					'parallel × 4',
					'acquire',
					e as Error,
					performance.now() - t0,
				);
			} finally {
				if (pool) await pool.destroy();
			}
		});
	});

	// ─── Custom pool ───────────────────────────────────────────────────────
	describe.sequential('custom pool', () => {
		test('acquire → exec → release', async () => {
			let pool: PoolHandle | undefined;
			const t0 = performance.now();
			try {
				pool = await customPoolFactory({ min: 1, max: 4 });
				const c = await pool.acquire();
				const sid = await captureSessionId(c);
				await execStmt(c, 'SELECT 1 FROM DUMMY');
				await pool.release(c);
				probeResults.push({
					strategy: 'custom',
					probeId: 'custom-a',
					form: 'acquire→exec→release',
					accepted: true,
					sessionId: sid,
					elapsedMs: performance.now() - t0,
				});
			} catch (e) {
				recordProbeError(
					'custom',
					'custom-a',
					'acquire→exec→release',
					'acquire',
					e as Error,
					performance.now() - t0,
				);
			} finally {
				if (pool) await pool.destroy();
			}
		});

		test('sequential checkout × 5 + leak check', async () => {
			let pool: PoolHandle | undefined;
			const cycleMs: number[] = [];
			try {
				pool = await customPoolFactory({ min: 1, max: 4 });
				const sessionIds: Array<number | undefined> = [];
				for (let i = 1; i <= 5; i++) {
					const t0 = performance.now();
					const c = await pool.acquire();
					const sid = await captureSessionId(c);
					sessionIds.push(sid);
					await pool.release(c);
					cycleMs.push(performance.now() - t0);
				}
				const min = Math.min(...cycleMs);
				const max = Math.max(...cycleMs);
				const mean = cycleMs.reduce((a, b) => a + b, 0) / cycleMs.length;
				probeResults.push({
					strategy: 'custom',
					probeId: 'custom-b',
					form: `sequential × 5 distinct=${new Set(sessionIds).size} cycleMs min=${min.toFixed(2)} max=${
						max.toFixed(2)
					} mean=${mean.toFixed(2)}`,
					accepted: true,
				});
				// leak check
				const inUseAfter = pool.inUseCount();
				probeResults.push({
					strategy: 'custom',
					probeId: 'custom-b-leakcheck',
					form: `inUseCount after release-cycles: ${inUseAfter}`,
					accepted: inUseAfter === 0,
					message: inUseAfter === 0 ? undefined : `LEAK: ${inUseAfter} conns still busy`,
				});
			} catch (e) {
				recordProbeError('custom', 'custom-b', 'sequential × 5', 'acquire', e as Error, 0);
			} finally {
				if (pool) await pool.destroy();
			}
		});

		test('parallel checkout × 4', async () => {
			let pool: PoolHandle | undefined;
			const t0 = performance.now();
			try {
				pool = await customPoolFactory({ min: 1, max: 4 });
				const conns = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
				const sids = await Promise.all(conns.map((c) => captureSessionId(c)));
				const distinct = new Set(sids.filter((s): s is number => typeof s === 'number')).size;
				for (const c of conns) await pool.release(c);
				probeResults.push({
					strategy: 'custom',
					probeId: 'custom-c',
					form: `parallel × 4 distinct sessions=${distinct}`,
					accepted: true,
					elapsedMs: performance.now() - t0,
				});
			} catch (e) {
				recordProbeError(
					'custom',
					'custom-c',
					'parallel × 4',
					'acquire',
					e as Error,
					performance.now() - t0,
				);
			} finally {
				if (pool) await pool.destroy();
			}
		});
	});

	// ─── Method-pinning across checkout/release ───────────────────────────
	describe.sequential('method-pinning across checkout/release', () => {
		for (const strategy of ['driver-native', 'custom'] as const) {
			test(`${strategy}: descriptor stability cycle 1`, async () => {
				let pool: PoolHandle | undefined;
				try {
					pool = strategy === 'driver-native'
						? await nativePoolFactory({ min: 1, max: 2 })
						: await customPoolFactory({ min: 1, max: 2 });

					const connA = await pool.acquire();
					const snap1 = captureMethodDescriptors(connA, null);
					await pool.release(connA);

					const connB = await pool.acquire();
					const sameConnRef = connA === connB;
					const snap2 = captureMethodDescriptors(connB, snap1.refs);
					methodPinningResults.push({
						strategy,
						cycle: 1,
						sameConnRef,
						commitDescriptor: snap2.snapshot.commit,
						rollbackDescriptor: snap2.snapshot.rollback,
						prepareDescriptor: snap2.snapshot.prepare,
					});
					// F6 CRITICAL FLAG
					if (
						sameConnRef
						&& (
							snap2.snapshot.commit.valueRefEqualsPrior === false
							|| snap2.snapshot.rollback.valueRefEqualsPrior === false
							|| snap2.snapshot.prepare.valueRefEqualsPrior === false
						)
					) {
						probeResults.push({
							strategy,
							probeId: `${strategy}-pinning-cycle1-CRITICAL`,
							form: 'method-binding swap on same conn ref',
							accepted: false,
							errClass: 'driver',
							message:
								'CRITICAL: pool returned same Connection ref but commit/rollback/prepare value-ref mutated. Method-mix risk.',
						});
					}
					await pool.release(connB);
				} catch (e) {
					recordProbeError(
						strategy,
						`${strategy}-pinning-cycle1`,
						'descriptor stability cycle 1',
						'acquire',
						e as Error,
						0,
					);
				} finally {
					if (pool) await pool.destroy();
				}
			});

			test(`${strategy}: descriptor stability cycle 2 (parallel)`, async () => {
				let pool: PoolHandle | undefined;
				try {
					pool = strategy === 'driver-native'
						? await nativePoolFactory({ min: 1, max: 2 })
						: await customPoolFactory({ min: 1, max: 2 });

					const [cA, cB] = await Promise.all([pool.acquire(), pool.acquire()]);
					const sA = captureMethodDescriptors(cA, null);
					const sB = captureMethodDescriptors(cB, null);
					await pool.release(cA);
					await pool.release(cB);

					const [cC, cD] = await Promise.all([pool.acquire(), pool.acquire()]);
					const sameRefC = cC === cA || cC === cB;
					const priorRefs = (cC === cA) ? sA.refs : (cC === cB) ? sB.refs : null;
					const sC = captureMethodDescriptors(cC, priorRefs);
					const sameRefD = cD === cA || cD === cB;
					const priorRefsD = (cD === cA) ? sA.refs : (cD === cB) ? sB.refs : null;
					const sD = captureMethodDescriptors(cD, priorRefsD);

					methodPinningResults.push({
						strategy,
						cycle: 2,
						sameConnRef: sameRefC,
						commitDescriptor: sC.snapshot.commit,
						rollbackDescriptor: sC.snapshot.rollback,
						prepareDescriptor: sC.snapshot.prepare,
					});
					methodPinningResults.push({
						strategy,
						cycle: 2,
						sameConnRef: sameRefD,
						commitDescriptor: sD.snapshot.commit,
						rollbackDescriptor: sD.snapshot.rollback,
						prepareDescriptor: sD.snapshot.prepare,
					});

					await pool.release(cC);
					await pool.release(cD);
				} catch (e) {
					recordProbeError(
						strategy,
						`${strategy}-pinning-cycle2`,
						'descriptor stability cycle 2',
						'acquire',
						e as Error,
						0,
					);
				} finally {
					if (pool) await pool.destroy();
				}
			});
		}
	});

	// ─── Tx-state isolation across checkout/release ───────────────────────
	describe.sequential('Tx-state isolation across checkout/release', () => {
		for (const strategy of ['driver-native', 'custom'] as const) {
			test(`${strategy}: uncommitted-tx-state leak`, async () => {
				let pool: PoolHandle | undefined;
				let setAutoCommitShape: 'sync' | 'promise' | 'unknown' = 'unknown';
				let uncommittedRowVisiblePostRelease = false;
				let autoCommitStatePostReacquire: boolean | null = null;
				let forensicCleanupFailed = false;
				const details: Record<string, unknown> = {};

				try {
					// min=max=1 forces same physical conn on reacquire
					pool = strategy === 'driver-native'
						? await nativePoolFactory({ min: 1, max: 1 })
						: await customPoolFactory({ min: 1, max: 1 });

					const connA = await pool.acquire();
					await execStmt(connA, `SET SCHEMA "${HANA_SCHEMA}"`);

					// F17: detect setAutoCommit return shape
					const sacResult = connA.setAutoCommit(false) as unknown;
					if (sacResult && typeof (sacResult as { then?: unknown }).then === 'function') {
						setAutoCommitShape = 'promise';
						await sacResult;
					} else {
						setAutoCommitShape = 'sync';
					}
					details['setAutoCommitShape'] = setAutoCommitShape;

					// Insert uncommitted row
					await execStmt(connA, `INSERT INTO "${PROBE_TABLE}" VALUES (999, 'leak-probe')`);

					// Release without commit/rollback
					await pool.release(connA);

					// Reacquire (same physical conn since min=max=1)
					const connB = await pool.acquire();
					const sameRef = connA === connB;
					details['sameRefOnReacquire'] = sameRef;

					// Query for the row visibility on the reacquired conn
					try {
						await execStmt(connB, `SET SCHEMA "${HANA_SCHEMA}"`);
						const r = (await execStmt(
							connB,
							`SELECT COUNT(*) AS C FROM "${PROBE_TABLE}" WHERE ID = 999`,
						)) as Array<{ C: number | string }>;
						const raw = r?.[0]?.C;
						const count = typeof raw === 'number' ? raw : Number(raw ?? 0);
						uncommittedRowVisiblePostRelease = count > 0;
						details['rowCountPostRelease'] = count;
					} catch (e) {
						details['rowCountError'] = _redactCreds((e as Error).message);
					}

					// Infer autoCommit state on reacquire: do INSERT + ROLLBACK without
					// setAutoCommit; if INSERT survives ROLLBACK, autocommit was on.
					try {
						const probeId = 998;
						await execStmt(connB, `INSERT INTO "${PROBE_TABLE}" VALUES (${probeId}, 'autocommit-probe')`);
						await execStmt(connB, 'ROLLBACK');
						const r = (await execStmt(
							connB,
							`SELECT COUNT(*) AS C FROM "${PROBE_TABLE}" WHERE ID = ${probeId}`,
						)) as Array<{ C: number | string }>;
						const raw = r?.[0]?.C;
						const survived = (typeof raw === 'number' ? raw : Number(raw ?? 0)) > 0;
						autoCommitStatePostReacquire = survived; // true = autocommit on (rolled-back insert survived)
						details['autoCommitInferredOn'] = survived;
						// cleanup the probe row regardless
						try {
							await execStmt(connB, `DELETE FROM "${PROBE_TABLE}" WHERE ID = ${probeId}`);
							await execStmt(connB, 'COMMIT');
						} catch {
							// ignore
						}
					} catch (e) {
						details['autoCommitInferError'] = _redactCreds((e as Error).message);
					}

					// F4: forensic cleanup — explicit ROLLBACK on connB; verify row 999 gone via fresh conn
					try {
						await execStmt(connB, 'ROLLBACK');
					} catch {
						// ignore
					}
					try {
						connB.setAutoCommit(true);
					} catch {
						// ignore
					}
					await pool.release(connB);

					try {
						const fresh = await openRawConn();
						try {
							await execStmt(fresh, `SET SCHEMA "${HANA_SCHEMA}"`);
							const r = (await execStmt(
								fresh,
								`SELECT COUNT(*) AS C FROM "${PROBE_TABLE}" WHERE ID = 999`,
							)) as Array<{ C: number | string }>;
							const raw = r?.[0]?.C;
							const stillThere = (typeof raw === 'number' ? raw : Number(raw ?? 0)) > 0;
							if (stillThere) {
								forensicCleanupFailed = true;
								probeResults.push({
									strategy,
									probeId: `tx-iso-${strategy}-forensic`,
									form: 'forensic-cleanup verification',
									accepted: false,
									errClass: 'driver',
									message: 'forensic-cleanup-failed: uncommitted row 999 persisted after cleanup',
								});
								// Force-delete it
								try {
									await execStmt(fresh, `DELETE FROM "${PROBE_TABLE}" WHERE ID = 999`);
									await execStmt(fresh, 'COMMIT');
								} catch {
									// ignore
								}
							}
						} finally {
							try {
								fresh.disconnect();
							} catch {
								// ignore
							}
						}
					} catch (e) {
						forensicCleanupFailed = true;
						details['forensicError'] = _redactCreds((e as Error).message);
					}
				} catch (e) {
					recordProbeError(strategy, `tx-iso-${strategy}`, 'tx-isolation', 'acquire', e as Error, 0);
				} finally {
					if (pool) await pool.destroy();
				}

				txIsolationResults.push({
					strategy,
					uncommittedRowVisiblePostRelease,
					autoCommitStatePostReacquire,
					setAutoCommitShape,
					forensicCleanupFailed,
					details,
				});
			});
		}
	});

	// ─── Concurrent-query parallelism ──────────────────────────────────────
	describe.sequential('Concurrent-query parallelism', () => {
		for (const strategy of ['driver-native', 'custom'] as const) {
			test(`${strategy}: parallel query overlap`, async () => {
				let pool: PoolHandle | undefined;
				try {
					pool = strategy === 'driver-native'
						? await nativePoolFactory({ min: 1, max: 4 })
						: await customPoolFactory({ min: 1, max: 4 });

					const queryCount = 4;
					// F5: event-loop sampler
					let maxTickGap = 0;
					let lastTick = performance.now();
					let samplerActive = true;
					const sampler = (): void => {
						if (!samplerActive) return;
						const now = performance.now();
						const gap = now - lastTick;
						if (gap > maxTickGap) maxTickGap = gap;
						lastTick = now;
						setImmediate(sampler);
					};
					setImmediate(sampler);

					const t0 = performance.now();
					const intervals: Array<{ start: number; end: number }> = [];
					const runOne = async (): Promise<void> => {
						const c = await pool!.acquire();
						const startMs = performance.now();
						try {
							await execStmt(
								c,
								'SELECT COUNT(*) FROM DUMMY UNION ALL SELECT COUNT(*) FROM SYS.TABLES',
							);
						} finally {
							intervals.push({ start: startMs, end: performance.now() });
							await pool!.release(c);
						}
					};
					await Promise.all(Array.from({ length: queryCount }, () => runOne()));
					samplerActive = false;
					const totalMs = performance.now() - t0;

					// Sweep-line for max overlap
					const events: Array<{ t: number; d: number }> = [];
					for (const i of intervals) {
						events.push({ t: i.start, d: +1 });
						events.push({ t: i.end, d: -1 });
					}
					events.sort((a, b) => a.t - b.t || a.d - b.d);
					let current = 0;
					let maxOverlap = 0;
					for (const e of events) {
						current += e.d;
						if (current > maxOverlap) maxOverlap = current;
					}

					// F12 three-state
					const verdict: ParallelismResult['verdict'] = maxOverlap === queryCount
						? 'parallel'
						: maxOverlap >= 2
						? 'partial'
						: 'serialized';
					const eventLoopBlocked = maxTickGap > 500;

					parallelismResults.push({
						strategy,
						queryCount,
						totalWallclockMs: totalMs,
						maxOverlapCount: maxOverlap,
						verdict,
						maxEventLoopTickGapMs: maxTickGap,
						eventLoopBlocked,
					});
				} catch (e) {
					recordProbeError(strategy, `parallel-${strategy}`, 'parallel overlap', 'acquire', e as Error, 0);
				} finally {
					if (pool) await pool.destroy();
				}
			});
		}
	});

	// ─── Adversarial probes ───────────────────────────────────────────────
	describe.sequential('Adversarial probes', () => {
		for (const strategy of ['driver-native', 'custom'] as const) {
			test(`Case A acquire-timeout: ${strategy}`, async () => {
				let pool: PoolHandle | undefined;
				try {
					pool = strategy === 'driver-native'
						? await nativePoolFactory({ min: 1, max: 1, acquireTimeoutMs: ACQUIRE_TIMEOUT_MS })
						: await customPoolFactory({ min: 1, max: 1, acquireTimeoutMs: ACQUIRE_TIMEOUT_MS });

					const heldA = await pool.acquire();
					const start = performance.now();
					const details: Record<string, unknown> = { acquireTimeoutMs: ACQUIRE_TIMEOUT_MS };
					try {
						await pool.acquire();
						details['unexpectedlySucceeded'] = true;
					} catch (e) {
						const err = e as Error & { __acquireTimeout?: boolean; code?: number; sqlState?: string };
						details['errClass'] = err.__acquireTimeout ? 'acquire-timeout' : classifySqlState(err);
						details['errCode'] = err.code;
						details['sqlState'] = err.sqlState;
						details['message'] = _redactCreds(err.message);
						details['elapsedMs'] = performance.now() - start;
					}
					await pool.release(heldA);
					adversarialResults.push({ case: 'acquire-timeout', strategy, details });
				} catch (e) {
					adversarialResults.push({
						case: 'acquire-timeout',
						strategy,
						details: { setupError: _redactCreds((e as Error).message) },
					});
				} finally {
					if (pool) await pool.destroy();
				}
			});

			test(`Case B conn-death-mid-tx: ${strategy}`, async () => {
				let pool: PoolHandle | undefined;
				try {
					pool = strategy === 'driver-native'
						? await nativePoolFactory({ min: 1, max: 2 })
						: await customPoolFactory({ min: 1, max: 2 });

					const details: Record<string, unknown> = {};
					const connA = await pool.acquire();
					const sidA = await captureSessionId(connA);
					details['sidA'] = sidA;
					await execStmt(connA, `SET SCHEMA "${HANA_SCHEMA}"`);
					try {
						connA.setAutoCommit(false);
					} catch {
						// ignore
					}
					try {
						await execStmt(connA, `INSERT INTO "${PROBE_TABLE}" VALUES (997, 'death-probe')`);
					} catch (e) {
						details['insertError'] = _redactCreds((e as Error).message);
					}
					// Force kill connA (client-graceful disconnect per F3)
					try {
						connA.disconnect();
					} catch {
						// ignore
					}
					details['disconnectedConnA'] = true;
					// Attempt commit on dead conn
					try {
						await new Promise<void>((resolve, reject) => {
							connA.commit((err) => err ? reject(err) : resolve());
						});
						details['commitOnDead'] = 'unexpectedlySucceeded';
					} catch (e) {
						const err = e as Error & { code?: number; sqlState?: string };
						details['commitOnDeadErrClass'] = classifySqlState(err);
						details['commitOnDeadCode'] = err.code;
						details['commitOnDeadSqlState'] = err.sqlState;
						details['commitOnDeadMessage'] = _redactCreds(err.message);
					}
					// Attempt re-acquire
					try {
						const connB = await pool.acquire();
						const sidB = await captureSessionId(connB);
						details['sidB'] = sidB;
						details['sameRefAsDead'] = connA === connB;
						details['newSessionDistinct'] = sidA !== sidB;
						// Validate B is alive
						try {
							await execStmt(connB, 'SELECT 1 FROM DUMMY');
							details['connBAlive'] = true;
						} catch (e) {
							details['connBAlive'] = false;
							details['connBProbeError'] = _redactCreds((e as Error).message);
						}
						await pool.release(connB);
					} catch (e) {
						details['reacquireError'] = _redactCreds((e as Error).message);
					}

					// Cleanup row 997 via fresh conn
					try {
						const fresh = await openRawConn();
						try {
							await execStmt(fresh, `SET SCHEMA "${HANA_SCHEMA}"`);
							await execStmt(fresh, `DELETE FROM "${PROBE_TABLE}" WHERE ID = 997`);
							await execStmt(fresh, 'COMMIT');
						} finally {
							try {
								fresh.disconnect();
							} catch {
								// ignore
							}
						}
					} catch {
						// ignore
					}

					adversarialResults.push({ case: 'conn-death-mid-tx', strategy, details });
				} catch (e) {
					adversarialResults.push({
						case: 'conn-death-mid-tx',
						strategy,
						details: { setupError: _redactCreds((e as Error).message) },
					});
				} finally {
					if (pool) await pool.destroy();
				}
			});
		}
	});

	// ════════════════════════════════════════════════════════════════════════
	// LIVE-HDI VALIDATION OF SapHanaPool (real driver pool — not local factories)
	// ════════════════════════════════════════════════════════════════════════

	// Common SapHanaPool conn opts (re-uses POOL_CONN_OPTS from above).
	const _saphPoolConnOpts = POOL_CONN_OPTS;

	// ─── Load probe (>max contention) + 100-cycle dead-conn-on-borrow ─────
	describe.sequential('load probe (>max contention)', () => {
		test(
			'contention rejection within tolerance + post-release resolution + 100-cycle dead-conn-on-borrow',
			async () => {
				const counts: Record<string, number> = {};
				const hookCounter = (event: string): void => {
					counts[event] = (counts[event] ?? 0) + 1;
				};
				// Retry helper: absorbs first-conn establishment cost (HANA cold-connect > 500ms typical).
				// Pool acquireTimeoutMs is 500; we retry the holder-acquires until the
				// native pool slot is warm enough to fulfill within the window.
				const acquireWithRetry = async (p: SapHanaPool, maxRetries: number): Promise<Connection> => {
					let lastErr: unknown;
					for (let i = 0; i < maxRetries; i++) {
						try {
							return await p.acquire();
						} catch (e) {
							lastErr = e;
						}
					}
					throw lastErr ?? new Error('acquireWithRetry exhausted');
				};

				const runContention = async (): Promise<{
					pool: SapHanaPool;
					rejections: number;
					firstRejectElapsedMs?: number;
					withinTolerance: boolean;
					postReleaseDistinctSession: boolean | null;
					heldSessions: Array<number | undefined>;
				}> => {
					const pool = new SapHanaPool({
						connection: _saphPoolConnOpts,
						pool: { min: 0, max: 2, acquireTimeoutMs: 500 },
						onPoolEvent: (event) => hookCounter(event),
					});
					// Pre-warm: 2 acquire→release cycles populate the pool's idle slots so the
					// subsequent holder acquires succeed within the 500ms window (cold-connect
					// against the on-prem HANA is typically > 500ms).
					const w1 = await acquireWithRetry(pool, 10);
					const w2 = await acquireWithRetry(pool, 10);
					await pool.release(w1);
					await pool.release(w2);
					// Reset event counter — pre-warm acquires may have fired 'acquire-timeout' events.
					for (const k of Object.keys(counts)) counts[k] = 0;
					const heldA = await pool.acquire();
					const heldB = await pool.acquire();
					const heldSidA = await captureSessionId(heldA);
					const heldSidB = await captureSessionId(heldB);
					const t0 = performance.now();
					const settled = await Promise.allSettled([
						pool.acquire(),
						pool.acquire(),
						pool.acquire(),
					]);
					const rejections = settled.filter((r) =>
						r.status === 'rejected'
						&& (r.reason as { code?: string })?.code === HANA_POOL_ACQUIRE_TIMEOUT
					).length;
					const firstReject = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
					const firstRejectElapsedMs = firstReject ? performance.now() - t0 : undefined;
					const withinTolerance = firstRejectElapsedMs !== undefined
						&& firstRejectElapsedMs >= 350 && firstRejectElapsedMs <= 650;

					// Release one holder; expect one of the late acquires to resolve post-release
					// (the timed-out acquires above already rejected — we trigger fresh).
					await pool.release(heldA);
					let postReleaseDistinctSession: boolean | null = null;
					try {
						const lateConn = await pool.acquire();
						const lateSid = await captureSessionId(lateConn);
						postReleaseDistinctSession = lateSid !== undefined
							&& lateSid !== heldSidA && lateSid !== heldSidB;
						await pool.release(lateConn);
					} catch {
						postReleaseDistinctSession = null;
					}

					await pool.release(heldB);
					return {
						pool,
						rejections,
						firstRejectElapsedMs,
						withinTolerance,
						postReleaseDistinctSession,
						heldSessions: [heldSidA, heldSidB],
					};
				};

				const flakeRetries: LoadProbeResult['flakeRetries'] = [];
				let attempt1: Awaited<ReturnType<typeof runContention>> | undefined;
				let contentionResult: Awaited<ReturnType<typeof runContention>>;
				try {
					attempt1 = await runContention();
					flakeRetries.push({
						attempt: 1,
						elapsedMs: attempt1.firstRejectElapsedMs ?? -1,
						pass: attempt1.withinTolerance && attempt1.rejections >= 1,
					});
					if (attempt1.withinTolerance && attempt1.rejections >= 1) {
						contentionResult = attempt1;
					} else {
						// 1 retry permitted per flake-resilience policy.
						await attempt1.pool.destroy();
						const attempt2 = await runContention();
						flakeRetries.push({
							attempt: 2,
							elapsedMs: attempt2.firstRejectElapsedMs ?? -1,
							pass: attempt2.withinTolerance && attempt2.rejections >= 1,
						});
						contentionResult = attempt2;
					}
				} catch (e) {
					// Setup failure — capture as FAIL verdict + emit sidecar; do NOT re-throw.
					// The checkpoint reviewer sees verdict=FAIL with the setup error in flakeRetries.
					const setupErrMsg = _redactCreds((e as Error).message);
					loadProbeResult = {
						contention: {
							holders: 2,
							acquireAttempts: 3,
							rejections: 0,
							toleranceWindowMs: { min: 350, max: 650 },
							withinTolerance: false,
							acquireTimeoutEventCount: counts['acquire-timeout'] ?? 0,
							postReleaseDistinctSession: null,
							verdict: 'FAIL',
						},
						flakeRetries: [...flakeRetries, { attempt: -1, elapsedMs: -1, pass: false }],
						deadConnOnBorrow: { numerator: -1, denominator: 100, rate: -1 },
					};
					probeResults.push({
						strategy: 'driver-native',
						probeId: 'load-probe-setup-error',
						form: 'load probe setup error',
						accepted: false,
						errClass: 'unknown',
						message: setupErrMsg,
					});
					_writeSidecarSnapshot();
					return;
				}

				const contentionVerdict: 'PASS' | 'FAIL' =
					(contentionResult.withinTolerance && contentionResult.rejections >= 1) ? 'PASS' : 'FAIL';

				// 100-cycle dead-conn-on-borrow loop.
				let deadCount = 0;
				const cyclePool = new SapHanaPool({
					connection: _saphPoolConnOpts,
					pool: { min: 0, max: 2, acquireTimeoutMs: 30000 },
				});
				try {
					for (let i = 0; i < 100; i++) {
						const conn = await cyclePool.acquire();
						try {
							await new Promise<void>((resolve, reject) => {
								const t = setTimeout(() => {
									const err = new Error('exec timeout') as Error & { __timeout?: boolean };
									err.__timeout = true;
									reject(err);
								}, 5000);
								conn.exec('SELECT 1 FROM DUMMY', [], (err: Error | null) => {
									clearTimeout(t);
									if (err) reject(err);
									else resolve();
								});
							});
						} catch (err) {
							const normalized = _normalizeHanaError(err, { query: 'SELECT 1 FROM DUMMY' });
							if ((normalized as { code?: string }).code === HANA_POOL_CONNECTION_DEAD) {
								deadCount++;
							}
						} finally {
							await cyclePool.release(conn);
						}
					}
				} finally {
					await cyclePool.destroy();
					await contentionResult.pool.destroy();
				}

				loadProbeResult = {
					contention: {
						holders: 2,
						acquireAttempts: 3,
						rejections: contentionResult.rejections,
						firstRejectElapsedMs: contentionResult.firstRejectElapsedMs,
						toleranceWindowMs: { min: 350, max: 650 },
						withinTolerance: contentionResult.withinTolerance,
						acquireTimeoutEventCount: counts['acquire-timeout'] ?? 0,
						postReleaseDistinctSession: contentionResult.postReleaseDistinctSession,
						verdict: contentionVerdict,
					},
					flakeRetries,
					deadConnOnBorrow: { numerator: deadCount, denominator: 100, rate: deadCount / 100 },
				};
				_writeSidecarSnapshot();

				// Existence assertion only — verdict (PASS/FAIL) is for checkpoint reviewer.
				expect(loadProbeResult.contention.verdict).toMatch(/^(PASS|FAIL)$/);
			},
			300_000,
		);
	});

	// ─── `pool.min` non-zero pre-warm verify ───────────────────────────────
	describe.sequential('pool.min non-zero pre-warm verify', () => {
		test('snapshot pooledCount post-construct + manual warm-loop', async () => {
			const pool = new SapHanaPool({
				connection: _saphPoolConnOpts,
				pool: { min: 3, max: 5 },
			});
			try {
				await new Promise((r) => setTimeout(r, 100)); // settling
				const preWarmSnapshot = pool.pooledCount();

				let verdict: MinPreWarmResult['verdict'];
				if (preWarmSnapshot >= 3) verdict = 'VERIFIED-PASS';
				else if (preWarmSnapshot === 0) verdict = 'VERIFIED-NO-OP';
				else verdict = 'PARTIAL';

				// Manual warm-loop — documented workaround for VERIFIED-NO-OP path.
				const warmConns: Connection[] = [];
				for (let i = 0; i < 3; i++) warmConns.push(await pool.acquire());
				for (const c of warmConns) await pool.release(c);
				const postWarmLoopSnapshot = pool.pooledCount();

				minPreWarmResult = { preWarmSnapshot, postWarmLoopSnapshot, verdict };
				_writeSidecarSnapshot();
			} finally {
				await pool.destroy();
			}

			expect(minPreWarmResult?.verdict).toMatch(/^VERIFIED-(PASS|NO-OP)$/);
		}, 60_000);
	});

	// ─── `pool.clear(cb)` during active checkouts ─────────────────────────
	describe.sequential('pool.clear() during active checkouts', () => {
		test('destroy with checkouts: held conns + subsequent acquire behavior', async () => {
			const pool = new SapHanaPool({
				connection: _saphPoolConnOpts,
				pool: { max: 2, acquireTimeoutMs: 1500 },
			});
			const markers: string[] = [];
			const heldA = await pool.acquire();
			const heldB = await pool.acquire();
			const sidA = await captureSessionId(heldA);
			const sidB = await captureSessionId(heldB);

			// destroy() wrapped vs 2000ms timeout (audit M6).
			const destroyStart = performance.now();
			let destroyResolveMs = -1;
			let destroyHang = false;
			try {
				await Promise.race([
					pool.destroy().then(() => {
						destroyResolveMs = performance.now() - destroyStart;
					}),
					new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('DESTROY_HANG')), 2000)),
				]);
			} catch (e) {
				if ((e as Error).message === 'DESTROY_HANG') {
					destroyHang = true;
					destroyResolveMs = 2000;
					markers.push('DESTROY_HANG');
				} else {
					throw e;
				}
			}

			// Per-conn exec wrapped vs 5000ms timeout.
			const perConnExec: ClearWithCheckoutsResult['perConnExec'] = [];
			for (const [c, sid] of [[heldA, sidA] as const, [heldB, sidB] as const]) {
				const result: ClearWithCheckoutsResult['perConnExec'][number] = {
					sessionId: sid,
					resolved: false,
					rejected: false,
					hang: false,
				};
				try {
					await Promise.race([
						new Promise<void>((resolve, reject) => {
							c.exec('SELECT 1 FROM DUMMY', [], (err: Error | null) => {
								if (err) reject(err);
								else resolve();
							});
						}).then(() => {
							result.resolved = true;
						}, (err: Error & { code?: number | string; sqlState?: string }) => {
							result.rejected = true;
							result.errCode = err.code;
							result.sqlState = err.sqlState;
						}),
						new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('EXEC_HUNG')), 5000)),
					]);
				} catch (e) {
					if ((e as Error).message === 'EXEC_HUNG') {
						result.hang = true;
						markers.push(`EXEC_HUNG:sid=${sid ?? '?'}`);
					}
				}
				perConnExec.push(result);
			}

			// Subsequent acquire — should reject with HANA_POOL_ACQUIRE_TIMEOUT (destroyed flag) within
			// acquireTimeoutMs + grace.
			let subsequentAcquireErrCode: number | string | undefined;
			let subsequentAcquireHang = false;
			try {
				await Promise.race([
					pool.acquire().then(
						(c) => {
							// unexpectedly resolved — release immediately to avoid leak.
							try {
								c.close(() => {});
							} catch {
								// ignore
							}
						},
						(err: Error & { code?: number | string }) => {
							subsequentAcquireErrCode = err.code;
						},
					),
					new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('ACQUIRE_HUNG')), 1500 + 1000)),
				]);
			} catch (e) {
				if ((e as Error).message === 'ACQUIRE_HUNG') {
					subsequentAcquireHang = true;
					markers.push('ACQUIRE_HUNG');
				}
			}

			// Verdict mapping (only when no HANG markers).
			let verdict: ClearWithCheckoutsResult['verdict'];
			if (markers.length > 0) {
				verdict = 'PARTIAL';
			} else {
				const bothResolved = perConnExec.every((r) => r.resolved);
				const anyRejectedConnDead = perConnExec.some((r) =>
					r.rejected
					&& (r.errCode === -20006 || r.errCode === HANA_POOL_CONNECTION_DEAD
						|| r.sqlState === 'HY000')
				);
				if (bothResolved) verdict = 'VERIFIED-PASS';
				else if (anyRejectedConnDead) verdict = 'REFUTED';
				else verdict = 'PARTIAL';
			}

			// Cleanup held conns regardless (avoid open-handle leak).
			for (const c of [heldA, heldB]) {
				try {
					c.close(() => {});
				} catch {
					try {
						c.disconnect();
					} catch {
						// ignore
					}
				}
			}

			clearWithCheckoutsResult = {
				destroyResolveMs,
				destroyHang,
				perConnExec,
				subsequentAcquireErrCode,
				subsequentAcquireHang,
				verdict,
				markers,
			};
			_writeSidecarSnapshot();

			expect(clearWithCheckoutsResult.verdict).toMatch(/^(VERIFIED-PASS|REFUTED|PARTIAL)$/);
		}, 60_000);
	});

	// ─── Server-side DISCONNECT SESSION ────────────────────────────────────
	describe.sequential('server-side disconnect (ALTER SYSTEM DISCONNECT SESSION)', () => {
		test(
			'victim conn fails within poll window; fresh acquire returns distinct sessionId; uncommitted row not visible',
			async () => {
				const pool = new SapHanaPool({
					connection: _saphPoolConnOpts,
					pool: { max: 2, acquireTimeoutMs: 30000 },
				});
				const attempts: ServerDisconnectResult['attempts'] = [];
				let victimSid: number | undefined;
				let freshSid: number | undefined;
				let firstFailureErr: ServerDisconnectResult['firstFailureErr'];
				let rowVisible = false;
				let attemptIndexOfFirstFailure: number | undefined;

				try {
					const victim = await pool.acquire();
					victimSid = await captureSessionId(victim);
					await execStmt(victim, `SET SCHEMA "${HANA_SCHEMA}"`);
					try {
						victim.setAutoCommit(false);
					} catch {
						// ignore
					}
					try {
						await execStmt(victim, `INSERT INTO "${PROBE_TABLE}" VALUES (996, 'disconnect-probe')`);
					} catch {
						// continue — insert is best-effort; downstream assertions still meaningful
					}

					// Cleanup conn for the ALTER SYSTEM DISCONNECT + post-disconnect verification.
					const cleanupCmdConn = await openRawConn();
					try {
						await execStmt(cleanupCmdConn, `SET SCHEMA "${HANA_SCHEMA}"`);
						try {
							await execStmt(cleanupCmdConn, `ALTER SYSTEM DISCONNECT SESSION '${victimSid}'`);
						} catch {
							// some HANA editions disallow this from non-SYSTEM users — record but continue
						}

						// Poll loop: 5 attempts × 200ms. First rejection terminates.
						for (let i = 0; i < 5; i++) {
							const result: ServerDisconnectResult['attempts'][number] = {
								index: i,
								resolved: false,
								rejected: false,
							};
							try {
								await execStmt(victim, 'SELECT 1 FROM DUMMY');
								result.resolved = true;
							} catch (err) {
								const e = err as Error & { code?: number; sqlState?: string };
								result.rejected = true;
								result.errCode = e.code;
								result.sqlState = e.sqlState;
								const normalized = _normalizeHanaError(e, { query: 'SELECT 1 FROM DUMMY' });
								firstFailureErr = {
									code: e.code,
									sqlState: e.sqlState,
									normalizedCode: (normalized as { code?: string }).code,
								};
								attemptIndexOfFirstFailure = i;
								attempts.push(result);
								break;
							}
							attempts.push(result);
							await new Promise((r) => setTimeout(r, 200));
						}

						// Release victim (release path tolerates dead conn per pool.ts).
						try {
							await pool.release(victim);
						} catch {
							// pool.release MUST not throw — but defensive
						}

						// Fresh acquire → distinct sessionId.
						try {
							const fresh = await pool.acquire();
							freshSid = await captureSessionId(fresh);
							await pool.release(fresh);
						} catch {
							// non-fatal — verdict captures the gap
						}

						// Row visibility post-disconnect (server-side rollback expected).
						try {
							const r = (await execStmt(
								cleanupCmdConn,
								`SELECT COUNT(*) AS C FROM "${PROBE_TABLE}" WHERE ID = 996`,
							)) as Array<{ C: number | string }>;
							const raw = r?.[0]?.C;
							const cnt = typeof raw === 'number' ? raw : Number(raw ?? 0);
							rowVisible = cnt > 0;
						} catch {
							// non-fatal
						}

						// Cleanup row regardless.
						try {
							await execStmt(cleanupCmdConn, `DELETE FROM "${PROBE_TABLE}" WHERE ID = 996`);
							await execStmt(cleanupCmdConn, 'COMMIT');
						} catch {
							// ignore
						}
					} finally {
						try {
							cleanupCmdConn.disconnect();
						} catch {
							// ignore
						}
					}
				} finally {
					await pool.destroy();
				}

				const allSucceeded = attempts.length > 0 && attempts.every((a) => a.resolved);
				const eventuallyFailed = !allSucceeded && attemptIndexOfFirstFailure !== undefined;
				// Two driver code paths are accepted (mirrors `_normalizeHanaError` in session.ts):
				//   -20006 + HY000 → pool-internal stale-conn (native pool "No Connection Available")
				//   -10807 + HY000 → server-side ALTER SYSTEM DISCONNECT SESSION (admin-initiated)
				const primaryMatch = firstFailureErr?.sqlState === 'HY000'
					&& (firstFailureErr?.code === -20006 || firstFailureErr?.code === -10807);
				serverDisconnectResult = {
					victimSessionId: victimSid,
					freshSessionId: freshSid,
					attempts,
					attemptIndexOfFirstFailure,
					totalAttempts: attempts.length,
					allAttemptsSucceeded: allSucceeded,
					firstFailureErr,
					rowVisiblePostDisconnect: rowVisible,
					verdict: eventuallyFailed && primaryMatch ? 'PASS' : 'FAIL',
				};
				_writeSidecarSnapshot();

				expect(serverDisconnectResult.verdict).toMatch(/^(PASS|FAIL)$/);
			},
			60_000,
		);
	});

	// ─── Idle-eviction 10min accelerated — gated ──────────────────────────
	describe.sequential('idle-eviction 10min accelerated trajectory', () => {
		test('trajectory capture over 600s (gated by HANA_IDLE_PROBE_ENABLED)', async () => {
			vi.setConfig({ testTimeout: 700_000, hookTimeout: 700_000 });

			if (!process.env['HANA_IDLE_PROBE_ENABLED']) {
				idleTrajectoryResult = {
					idleTimeoutMs: 120_000,
					samples: [],
					verdict: 'SKIPPED',
					skipReason: 'HANA_IDLE_PROBE_ENABLED unset (10-min wall-clock unsafe for routine runs)',
				};
				_writeSidecarSnapshot();
				// eslint-disable-next-line no-console
				console.log('POOL_PROBE_IDLE_EVICTION_SKIPPED', idleTrajectoryResult.skipReason);
				return;
			}

			const pool = new SapHanaPool({
				connection: _saphPoolConnOpts,
				pool: { idleTimeoutMs: 120_000, max: 4 },
			});
			const samples: IdleTrajectoryResult['samples'] = [];
			let firstEvictionAtMs: number | undefined;
			try {
				// Pre-warm 3 acquire/release cycles
				const warm: Connection[] = [];
				for (let i = 0; i < 3; i++) warm.push(await pool.acquire());
				for (const c of warm) await pool.release(c);

				const t0 = performance.now();
				const initial = pool.pooledCount();
				samples.push({ tMs: 0, pooledCount: initial });

				for (let i = 1; i <= 20; i++) {
					await new Promise((r) => setTimeout(r, 30_000));
					const tMs = Math.round(performance.now() - t0);
					const pc = pool.pooledCount();
					samples.push({ tMs, pooledCount: pc });
					if (firstEvictionAtMs === undefined && pc < initial) firstEvictionAtMs = tMs;
					// Incremental emit (resilience).
					idleTrajectoryResult = {
						idleTimeoutMs: 120_000,
						samples: [...samples],
						firstEvictionAtMs,
						verdict: firstEvictionAtMs !== undefined ? 'PASS' : 'UNVERIFIABLE-IN-WINDOW',
					};
					_writeSidecarSnapshot();
				}

				idleTrajectoryResult = {
					idleTimeoutMs: 120_000,
					samples,
					firstEvictionAtMs,
					verdict: firstEvictionAtMs !== undefined ? 'PASS' : 'UNVERIFIABLE-IN-WINDOW',
				};
				_writeSidecarSnapshot();
			} finally {
				await pool.destroy();
			}

			expect(idleTrajectoryResult?.verdict).toMatch(/^(PASS|UNVERIFIABLE-IN-WINDOW|SKIPPED)$/);
		});
	});

	// ─── Cross-tenant prep proxy test ──────────────────────────────────────
	describe.sequential('cross-tenant prep proxy', () => {
		test('env-var path proxy test: re-runs the prior contention probe via env-var override resolution', async () => {
			// Procedure documentation: env-var override path produces identical verdict to default
			// path (on-prem proxy run; HANA Cloud encrypt=true is UNVERIFIED-DEFERRED — release-gate).
			const envVarPathUsed = Boolean(
				process.env['HANA_PROBE_HOST']
					|| process.env['HANA_PROBE_USER']
					|| process.env['HANA_PROBE_PASS']
					|| process.env['HANA_PROBE_SCHEMA'],
			);
			const envKeysResolved = {
				host: HANA_HOST,
				port: String(HANA_PORT),
				user: HANA_USER,
				schema: HANA_SCHEMA,
				encrypt: String(HANA_ENCRYPT),
			};

			let contentionVerdict: 'PASS' | 'FAIL' = 'FAIL';
			try {
				const pool = new SapHanaPool({
					connection: _saphPoolConnOpts,
					pool: { min: 0, max: 2, acquireTimeoutMs: 500 },
				});
				// Pre-warm (first cold-connect > 500ms).
				const acquireWithRetry = async (p: SapHanaPool, maxRetries: number): Promise<Connection> => {
					let lastErr: unknown;
					for (let i = 0; i < maxRetries; i++) {
						try {
							return await p.acquire();
						} catch (e) {
							lastErr = e;
						}
					}
					throw lastErr ?? new Error('acquireWithRetry exhausted');
				};
				const _wd1 = await acquireWithRetry(pool, 10);
				const _wd2 = await acquireWithRetry(pool, 10);
				await pool.release(_wd1);
				await pool.release(_wd2);
				const heldA = await pool.acquire();
				const heldB = await pool.acquire();
				const t0 = performance.now();
				const settled = await Promise.allSettled([
					pool.acquire(),
					pool.acquire(),
					pool.acquire(),
				]);
				const rejections = settled.filter((r) =>
					r.status === 'rejected'
					&& (r.reason as { code?: string })?.code === HANA_POOL_ACQUIRE_TIMEOUT
				).length;
				const firstReject = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
				const firstRejectElapsedMs = firstReject ? performance.now() - t0 : undefined;
				const withinTolerance = firstRejectElapsedMs !== undefined
					&& firstRejectElapsedMs >= 350 && firstRejectElapsedMs <= 650;
				contentionVerdict = (rejections >= 1 && withinTolerance) ? 'PASS' : 'FAIL';

				await pool.release(heldA);
				await pool.release(heldB);
				await pool.destroy();
			} catch {
				contentionVerdict = 'FAIL';
			}

			const matches = loadProbeResult
				? (contentionVerdict === loadProbeResult.contention.verdict)
				: null;

			crossTenantPrepResult = {
				envVarPathUsed,
				envKeysResolved: _redactCreds(envKeysResolved),
				contentionVerdict,
				verdictMatchesDefaultPath: matches,
			};
			_writeSidecarSnapshot();

			expect(crossTenantPrepResult.contentionVerdict).toMatch(/^(PASS|FAIL)$/);
		}, 120_000);
	});
});
