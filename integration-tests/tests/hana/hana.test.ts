import { type Connection, createConnection } from '@sap/hana-client';
import { sql } from 'drizzle-orm';
import {
	alphanum,
	char,
	hanaTable,
	integer,
	seconddate,
	shorttext,
	smalldecimal,
	text,
	tinyint,
	varbinary,
} from 'drizzle-orm/hana-core';
import { drizzle } from 'drizzle-orm/sap-hana';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/**
 * Live HANA Cloud smoke suite.
 * Validates transaction polarity + native commit/rollback, error normalizer +
 * DSN overload, lazy connect, isolation/access-mode behavior, and HANA-native
 * column type roundtrips against a real HDI tenant.
 *
 * Gated behind HANA_TEST_ENABLED — see integration-tests/vitest.config.ts.
 * Run: `pnpm --filter integration-tests test:hana`
 */

const HANA_HOST = '143.244.150.208';
const HANA_PORT = 39041;
const HANA_USER = 'drizzle';
const HANA_PASS = 'Drizzle123';
const HANA_SCHEMA = 'DRIZZLE';
const HANA_ENCRYPT = false;

export const HANA_CONN = {
	host: HANA_HOST,
	port: HANA_PORT,
	user: HANA_USER,
	password: HANA_PASS,
	schema: HANA_SCHEMA,
} as const;

const RUN_ID = `${process.pid}_${Date.now()}`;
const PROBE_TABLE = `T_DRIZZLE_HANA_PROBE_${RUN_ID}`;
const MISSING_TABLE = `T_DRIZZLE_HANA_DOES_NOT_EXIST_${RUN_ID}`;

const openConnections: Connection[] = [];

function openConn(): Connection {
	const c = createConnection();
	c.connect({
		host: HANA_HOST,
		port: HANA_PORT,
		user: HANA_USER,
		password: HANA_PASS,
		encrypt: HANA_ENCRYPT,
		communicationTimeout: 10000,
	});
	openConnections.push(c);
	return c;
}

function execRaw(c: Connection, stmt: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		c.exec(stmt, [], (err: Error | null, res: unknown) => {
			if (err) reject(err);
			else resolve(res);
		});
	});
}

const probeTable = hanaTable(PROBE_TABLE, {
	id: char('ID', { length: 32 }).primaryKey(),
});

describe.sequential('hana smoke', () => {
	let conn: Connection;

	beforeAll(async () => {
		conn = openConn();
		await execRaw(conn, `SET SCHEMA "${HANA_SCHEMA}"`);
		// Create probe table; idempotent via try/catch so re-runs of a leaked
		// table from a previous crashed suite don't blow up.
		try {
			await execRaw(conn, `CREATE COLUMN TABLE "${PROBE_TABLE}" (ID CHAR(32) PRIMARY KEY)`);
		} catch {
			// table already exists — truncate
			await execRaw(conn, `TRUNCATE TABLE "${PROBE_TABLE}"`);
		}
	});

	afterAll(async () => {
		for (const c of openConnections) {
			try {
				await execRaw(c, `DROP TABLE "${PROBE_TABLE}"`);
			} catch {
				// ignore — best-effort cleanup
			}
			try {
				c.disconnect();
			} catch {
				// ignore
			}
		}
	});

	beforeEach(async () => {
		try {
			await execRaw(conn, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
		} catch {
			// conn may not be open yet for the first test that constructs it; safe to ignore
		}
	});

	test('transaction polarity + native rollback', async () => {
		const db = drizzle({ client: conn });
		const idCommit = 'A'.repeat(32);
		const idRollback = 'B'.repeat(32);

		// Tx that throws → rollback path
		await expect(
			db.transaction(async (tx) => {
				await tx.insert(probeTable).values({ id: idRollback });
				const seen = await tx.select().from(probeTable);
				expect(seen.find((r) => r.id === idRollback)).toBeDefined();
				throw new Error('force-rollback');
			}),
		).rejects.toThrow('force-rollback');

		// Row must be absent after rollback
		const afterRollback = await db.select().from(probeTable);
		expect(afterRollback.find((r) => r.id === idRollback)).toBeUndefined();

		// setAutoCommit(true) restored by finally: next non-tx insert visible
		await db.insert(probeTable).values({ id: idCommit });
		const afterAuto = await db.select().from(probeTable);
		expect(afterAuto.find((r) => r.id === idCommit)).toBeDefined();

		// cleanup row
		await execRaw(conn, `DELETE FROM "${PROBE_TABLE}" WHERE ID = '${idCommit}'`);
	});

	test('error normalizer wraps real driver errors', async () => {
		const db = drizzle({ client: conn });
		let caught: unknown;
		try {
			await db.execute(sql.raw(`SELECT * FROM "${MISSING_TABLE}"`));
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeDefined();

		// Outer = DrizzleQueryError (queryWithCache wrapper); inner cause = HanaDriverError
		const outer = caught as Error & { cause?: unknown; query?: unknown };
		expect(outer).toHaveProperty('cause');
		expect(outer.message.length).toBeGreaterThan(0);
		expect(outer.message).toContain(MISSING_TABLE);

		const inner = outer.cause as Error & {
			cause?: unknown;
			code?: unknown;
			sqlState?: unknown;
			query?: unknown;
		};
		expect(typeof inner.code).toBe('number');
		expect(typeof inner.sqlState).toBe('string');
		expect(inner.message.length).toBeGreaterThan(0);
		expect(inner.query).toContain(MISSING_TABLE);
		// Driver-level original error preserved as inner.cause
		expect(inner.cause).toBeDefined();
	});

	test('DSN overload connects against live HDI', async () => {
		const dsn = `serverNode=${HANA_HOST}:${HANA_PORT};uid=${HANA_USER};pwd=${HANA_PASS};encrypt=${
			HANA_ENCRYPT ? 'TRUE' : 'FALSE'
		};communicationTimeout=10000`;
		const db = drizzle(dsn);
		const client = (db as unknown as { $client: Connection }).$client;
		openConnections.push(client);
		await new Promise<void>((resolve, reject) => {
			client.connect((err: Error | null) => (err ? reject(err) : resolve()));
		});
		// db.execute path uses rowsAsArray:true in driver layer — rows are arrays not objects.
		const rows = (await db.execute(sql`SELECT 1 AS ONE FROM DUMMY`)) as unknown[];
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBe(1);
		expect(Number((rows[0] as unknown[])[0])).toBe(1);
		try {
			client.disconnect();
		} catch {
			// ignore
		}
	});

	test('DDL inside transaction rolls back; setAutoCommit(true) restored', async () => {
		const db = drizzle({ client: conn });
		const tableName = `TEST_DDL_TX_${Date.now()}`;

		await expect(
			db.transaction(async (tx) => {
				await tx.execute(sql.raw(`CREATE TABLE "${tableName}" (ID INTEGER)`));
				throw new Error('rollback-trigger');
			}),
		).rejects.toThrow('rollback-trigger');

		const sysTables = await db.execute(
			sql`SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ${tableName}`,
		) as unknown[];
		expect(sysTables.length).toBe(0);

		const probeId = `R${Date.now().toString().slice(-30)}`.padEnd(32, 'X').slice(0, 32);
		await db.insert(probeTable).values({ id: probeId });
		const seen = await db.select().from(probeTable);
		expect(seen.find((r) => r.id === probeId)).toBeDefined();
		await execRaw(conn, `DELETE FROM "${PROBE_TABLE}" WHERE ID = '${probeId}'`);
	});

	test('per-tx isolation level observed in M_TRANSACTIONS (with RR→SER promotion)', async () => {
		const db = drizzle({ client: conn });
		const cases: Array<[level: 'read committed' | 'serializable' | 'repeatable read', expected: string]> = [
			['read committed', 'READ COMMITTED'],
			['serializable', 'SERIALIZABLE'],
			['repeatable read', 'SERIALIZABLE'],
		];
		for (const [level, expected] of cases) {
			const observed = await db.transaction(async (tx) => {
				const rows = await tx.execute(
					sql`SELECT ISOLATION_LEVEL FROM M_TRANSACTIONS WHERE CONNECTION_ID = CURRENT_CONNECTION`,
				) as unknown[];
				return (rows[0] as unknown[])[0];
			}, { isolationLevel: level });
			expect(observed).toBe(expected);
		}
	});

	test('per-tx accessMode read-only rejects writes; read-write accepts', async () => {
		const db = drizzle({ client: conn });
		const tableName = `T_RW_${Date.now()}`;
		await execRaw(conn, `CREATE COLUMN TABLE "${tableName}" (ID INTEGER PRIMARY KEY)`);
		try {
			let caught: unknown;
			try {
				await db.transaction(async (tx) => {
					await tx.execute(sql.raw(`INSERT INTO "${tableName}" VALUES (1)`));
				}, { accessMode: 'read only' });
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeDefined();
			// Outer = DrizzleQueryError (queryWithCache wrapper); inner cause = HanaDriverError
			// with the actual "cannot change this transaction's access mode from read-only" message.
			const outer = caught as Error & { cause?: { message?: string } };
			const innerMsg = String(outer?.cause?.message ?? outer?.message ?? '').toLowerCase();
			expect(innerMsg).toContain('read-only');
			const after4 = await execRaw(conn, `SELECT COUNT(*) AS C FROM "${tableName}" WHERE ID = 1`) as unknown[];
			expect(Number((after4[0] as { C: number | string }).C)).toBe(0);

			await db.transaction(async (tx) => {
				await tx.execute(sql.raw(`INSERT INTO "${tableName}" VALUES (1)`));
			}, { accessMode: 'read write' });
			const after5 = await execRaw(conn, `SELECT COUNT(*) AS C FROM "${tableName}" WHERE ID = 1`) as unknown[];
			expect(Number((after5[0] as { C: number | string }).C)).toBe(1);
		} finally {
			try {
				await execRaw(conn, `DROP TABLE "${tableName}"`);
			} catch {
				// ignore
			}
		}
	});

	test('drizzle(dsn) lazy connect — covers execute AND query-builder paths', async () => {
		const dsn = `serverNode=${HANA_HOST}:${HANA_PORT};uid=${HANA_USER};pwd=${HANA_PASS};encrypt=${
			HANA_ENCRYPT ? 'TRUE' : 'FALSE'
		};communicationTimeout=10000;currentSchema=${HANA_SCHEMA}`;
		const lazyDb = drizzle(dsn);
		openConnections.push((lazyDb as unknown as { $client: Connection }).$client);

		// (a) ad-hoc execute path — first call must lazily connect
		const rows = await lazyDb.execute(sql`SELECT 1 AS ONE FROM DUMMY`) as unknown[];
		expect(Number((rows[0] as unknown[])[0])).toBe(1);

		// (b) second execute must not re-connect (gate cached)
		const rows2 = await lazyDb.execute(sql`SELECT 2 AS TWO FROM DUMMY`) as unknown[];
		expect(Number((rows2[0] as unknown[])[0])).toBe(2);

		// Fresh db, FIRST call is via builder — proves gate sits below builder layer.
		const freshDb = drizzle(dsn);
		openConnections.push((freshDb as unknown as { $client: Connection }).$client);
		const builderRows = await freshDb.select().from(probeTable);
		expect(Array.isArray(builderRows)).toBe(true); // no "No Connection Available"
	});

	test('drizzle({ connection: dsn }) lazy connect', async () => {
		const dsn = `serverNode=${HANA_HOST}:${HANA_PORT};uid=${HANA_USER};pwd=${HANA_PASS};encrypt=${
			HANA_ENCRYPT ? 'TRUE' : 'FALSE'
		};communicationTimeout=10000;currentSchema=${HANA_SCHEMA}`;
		const db = drizzle({ connection: dsn });
		openConnections.push((db as unknown as { $client: Connection }).$client);

		const rows = await db.execute(sql`SELECT 1 FROM DUMMY`) as unknown[];
		expect((rows[0] as unknown[])[0]).toBeDefined();
	});

	test('read uncommitted rejected pre-driver; no SQL emitted', async () => {
		const logged: Array<{ sql: string; params: unknown[] }> = [];
		const spyLogger = {
			logQuery(query: string, params: unknown[]) {
				logged.push({ sql: query, params });
			},
		};
		const spyDb = drizzle({ client: conn, logger: spyLogger });

		await expect(
			spyDb.transaction(async () => {
				/* never reached */
			}, { isolationLevel: 'read uncommitted' as any }),
		).rejects.toMatchObject({ code: 'HANA_ISOLATION_READ_UNCOMMITTED_UNSUPPORTED' });

		expect(logged.length).toBe(0);
	});
});

function rand6(): string {
	return Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
}

describe.sequential('column parity — HANA-native types roundtrip', () => {
	let conn: Connection;

	beforeAll(async () => {
		conn = createConnection();
		await new Promise<void>((res, rej) =>
			conn.connect({
				host: HANA_HOST,
				port: HANA_PORT,
				user: HANA_USER,
				password: HANA_PASS,
				encrypt: HANA_ENCRYPT,
				communicationTimeout: 10000,
			}, (err: Error | null) => err ? rej(err) : res())
		);
		await execRaw(conn, `SET SCHEMA "${HANA_SCHEMA}"`);
		openConnections.push(conn);
	});

	test('tinyint roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: tinyint('V') });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('tinyint');
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${42})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			expect(Number((rows[0] as unknown[])[1])).toBe(42);
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});

	test('smalldecimal roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: smalldecimal('V') });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('smalldecimal');
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${'3.1415'})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			expect(Number((rows[0] as unknown[])[1])).toBeCloseTo(3.1415, 3);
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});

	test('seconddate roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: seconddate('V') });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('seconddate');
		const expected = new Date('2026-06-01T12:34:56Z');
		// HANA SECONDDATE expects 'YYYY-MM-DD HH:MM:SS' literal form via parameter
		const literal = expected.toISOString().slice(0, 19).replace('T', ' ');
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${literal})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			const got = (rows[0] as unknown[])[1];
			// driver may return Date or 'YYYY-MM-DD HH:MM:SS' string; accept either
			if (got instanceof Date) {
				expect(got.getTime()).toBe(expected.getTime());
			} else {
				expect(String(got).slice(0, 19)).toBe(literal);
			}
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});

	test('varbinary roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: varbinary('V', { length: 8 }) });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('varbinary(8)');
		const expected = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${expected})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			const got = (rows[0] as unknown[])[1];
			const buf = Buffer.isBuffer(got) ? got : Buffer.from(got as ArrayBuffer);
			expect(Buffer.compare(buf, expected)).toBe(0);
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});

	test('alphanum roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: alphanum('V', { length: 16 }) });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('alphanum(16)');
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${'ABC123'})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			expect(String((rows[0] as unknown[])[1]).trim()).toBe('ABC123');
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});

	test('shorttext roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: shorttext('V', { length: 32 }) });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('shorttext(32)');
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${'hello world'})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			expect((rows[0] as unknown[])[1]).toBe('hello world');
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});

	test('text roundtrip', async () => {
		const name = `DRIZZLE_02_04_TYPES_${rand6()}`;
		const schema = hanaTable(name, { id: integer('ID'), v: text('V') });
		const typeToken = (schema as unknown as { v: { getSQLType: () => string } }).v.getSQLType();
		expect(typeToken).toBe('text');
		const value = 'a longer text value with some unicode: 你好';
		const db = drizzle({ client: conn });
		const tbl = sql.raw(`"${name}"`);
		try {
			await db.execute(sql.raw(`CREATE COLUMN TABLE "${name}" (ID INTEGER, V ${typeToken})`));
			await db.execute(sql`INSERT INTO ${tbl} (ID, V) VALUES (1, ${value})`);
			const rows = (await db.execute(sql`SELECT ID, V FROM ${tbl} WHERE ID = 1`)) as unknown[];
			expect(rows.length).toBe(1);
			expect((rows[0] as unknown[])[1]).toBe(value);
		} finally {
			try {
				await db.execute(sql.raw(`DROP TABLE "${name}"`));
			} catch {
				// best-effort
			}
		}
	});
});

describe('drizzle.mock() driver-method coverage', () => {
	test('drizzle.mock() supports execute + transaction without throwing', async () => {
		const mockDb = drizzle.mock();
		const result = await mockDb.execute(sql`SELECT 1`);
		expect(Array.isArray(result)).toBe(true);
		await mockDb.transaction(async (tx) => {
			const inner = await tx.execute(sql`SELECT 2`);
			expect(Array.isArray(inner)).toBe(true);
		});
	});

	test('drizzle.mock() rejects READ UNCOMMITTED isolation', async () => {
		const mockDb = drizzle.mock();
		await expect(
			mockDb.transaction(async () => {}, { isolationLevel: 'read uncommitted' as any }),
		).rejects.toMatchObject({ code: 'HANA_ISOLATION_READ_UNCOMMITTED_UNSUPPORTED' });
	});
});
