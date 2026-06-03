import { type Connection, type ConnectionOptions, createConnection } from '@sap/hana-client';
import * as V1 from '~/_relations.ts';
import type { Cache } from '~/cache/core/cache.ts';
import { entityKind } from '~/entity.ts';
import { HanaDatabase } from '~/hana-core/db.ts';
import { HanaDialect } from '~/hana-core/dialect.ts';
import type { Logger } from '~/logger.ts';
import { DefaultLogger } from '~/logger.ts';
import type { AnyRelations, EmptyRelations } from '~/relations.ts';
import type { DrizzleConfig } from '~/utils.ts';
import { type HanaPoolOptions, SapHanaPool } from './pool.ts';
import type { SapHanaClient, SapHanaQueryResultHKT } from './session.ts';
import { SapHanaSession } from './session.ts';

export interface HanaDriverOptions {
	logger?: Logger;
	cache?: Cache;
}

export class SapHanaDriver {
	static readonly [entityKind]: string = 'SapHanaDriver';

	constructor(
		private client: SapHanaClient,
		private dialect: HanaDialect,
		private options: HanaDriverOptions = {},
	) {
	}

	createSession(
		relations: AnyRelations,
		schema: V1.RelationalSchemaConfig<V1.TablesRelationalConfig> | undefined,
	): SapHanaSession<Record<string, unknown>, AnyRelations, V1.TablesRelationalConfig> {
		return new SapHanaSession(this.client, this.dialect, relations, schema, {
			logger: this.options.logger,
			cache: this.options.cache,
		});
	}
}

export class SapHanaDatabase<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
> extends HanaDatabase<SapHanaQueryResultHKT, TSchema, TRelations> {
	static override readonly [entityKind]: string = 'SapHanaDatabase';
}

function construct<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
	TClient extends SapHanaClient = SapHanaClient,
>(
	client: TClient,
	config: DrizzleConfig<TSchema, TRelations> = {},
): SapHanaDatabase<TSchema, TRelations> & {
	$client: TClient;
} {
	const dialect = new HanaDialect({ casing: config.casing });
	let logger;
	if (config.logger === true) {
		logger = new DefaultLogger();
	} else if (config.logger !== false) {
		logger = config.logger;
	}

	let schema: V1.RelationalSchemaConfig<V1.TablesRelationalConfig> | undefined;
	if (config.schema) {
		const tablesConfig = V1.extractTablesRelationalConfig(
			config.schema,
			V1.createTableRelationsHelpers,
		);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap,
		};
	}

	const relations = config.relations ?? {} as TRelations;
	const driver = new SapHanaDriver(client, dialect, { logger, cache: config.cache });
	const session = driver.createSession(relations, schema);
	const db = new SapHanaDatabase(
		dialect,
		session,
		relations,
		schema as V1.RelationalSchemaConfig<any>,
	) as SapHanaDatabase<TSchema>;
	(<any> db).$client = client;
	(<any> db).$cache = config.cache;
	if ((<any> db).$cache) {
		(<any> db).$cache['invalidate'] = config.cache?.onMutate;
	}

	return db as any;
}

export function _parseHanaDSN(dsn: string): ConnectionOptions {
	const opts: ConnectionOptions = {};
	for (const pair of dsn.split(';')) {
		const idx = pair.indexOf('=');
		if (idx <= 0) continue;
		const key = pair.slice(0, idx).trim();
		const value = pair.slice(idx + 1).trim();
		if (key) opts[key] = value;
	}
	return opts;
}

/**
 * Create a `SapHanaPool` over `@sap/hana-client` native `ConnectionPool`.
 *
 * @remarks
 * Defaults: `{ min: 0, max: 10, acquireTimeoutMs: 30000 }`. `idleTimeoutMs` is
 * UNSET by default (maps to native `maxPooledIdleTime` = 0 = no eviction).
 *
 * Public-API additions (SemVer-minor, since 1.0.0-beta.5): `SapHanaPool`,
 * `createPool`, `HanaPoolOptions`, `PoolEventName`, `isSapHanaPool` guard, and
 * error code constants `HANA_POOL_ACQUIRE_TIMEOUT` + `HANA_POOL_CONNECTION_DEAD`.
 * String values of those constants are STABLE within 1.0.x.
 *
 * @stability stable since 1.0.0-beta.5
 */
export function createPool(opts: HanaPoolOptions): SapHanaPool {
	return new SapHanaPool(opts);
}

/**
 * Create a Drizzle ORM instance for SAP HANA.
 *
 * @remarks
 * **DSN format:** HANA property-string `key=value;key=value` (e.g.,
 * `"serverNode=host:443;uid=user;pwd=pass;encrypt=true"`). URL-style
 * DSNs (`hana://...`) are NOT supported in this release — pass property-string
 * form or a ConnectionOptions object.
 *
 * **communicationTimeout:** Default per `@sap/hana-client` is `0` (disabled).
 * Recommended production value: `60000` (60s). Drizzle does not hardcode a
 * default — opt in via `connection: { communicationTimeout: 60000, ... }`
 * or DSN `"...;communicationTimeout=60000"`.
 * Reference: SAP_HANA_Client_Interface_Programming_Reference_en.pdf §4.4.4 p.535.
 *
 * **Lazy connect:** The first call to any drizzle query path —
 * `db.execute`, `db.select`, `db.insert`, `db.update`, `db.delete`, or
 * `db.transaction` (which itself wraps `setAutoCommit(false)` + pre-tx
 * SQL emissions) — lazily awaits `client.connect()` exactly once via an
 * internal symbol-slot cache (`_CONNECT_GATE`). Subsequent calls on the
 * same Connection reuse the cached promise (single-connect guarantee).
 * If the caller already invoked `client.connect()` explicitly, the gate
 * resolves immediately via the `state()` fast-path or treats HANA's
 * "Already Connected" error (errCode -20004) as success.
 *
 * **Pool branch (since 1.0.0-beta.5):**
 * - `drizzle({ client: pool })` accepts a pre-constructed `SapHanaPool`
 * - `drizzle({ connection, pool: {max:20, ...} })` constructs a pool internally
 *
 * Transaction scope acquires ONE conn at entry, releases in `finally`. Statement
 * scope (outside any tx) acquires per-call. Concurrent `transaction()` invocations
 * each get their OWN acquired conn (no session-instance storage).
 *
 * @param params - One of:
 *   - `(connectionString)` — HANA property-string DSN (NOT a `hana://` URL)
 *   - `(connectionString, config)` — DSN + Drizzle config
 *   - `({ client | connection, ...config })` — explicit Connection / SapHanaPool / ConnectionOptions.
 *     `connection` may be a HANA property-string DSN or a ConnectionOptions object;
 *     pass `communicationTimeout` here for production deployments.
 *   - `({ connection, pool: {...}, ...config })` — opt into pool with nested pool config.
 */
export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
	TClient extends SapHanaClient = Connection,
>(
	...params:
		| [string]
		| [string, DrizzleConfig<TSchema, TRelations>]
		| [
			& DrizzleConfig<TSchema, TRelations>
			& ({
				client: TClient;
			} | {
				connection: ConnectionOptions | string;
				pool?: HanaPoolOptions['pool'];
				onPoolEvent?: HanaPoolOptions['onPoolEvent'];
			}),
		]
): SapHanaDatabase<TSchema, TRelations> & {
	$client: TClient;
} {
	if (typeof params[0] === 'string') {
		const client = createConnection(_parseHanaDSN(params[0])) as TClient;
		return construct(client, params[1] as DrizzleConfig<TSchema, TRelations> | undefined) as any;
	}

	const { client, connection, pool, onPoolEvent, ...drizzleConfig } = params[0] as
		& DrizzleConfig<TSchema, TRelations>
		& {
			client?: TClient;
			connection?: ConnectionOptions | string;
			pool?: HanaPoolOptions['pool'];
			onPoolEvent?: HanaPoolOptions['onPoolEvent'];
		};

	if (client) {
		return construct(client, drizzleConfig);
	}

	// Pool branch (since 1.0.0-beta.5): opt-in only — DSN-string-only path stays a single Connection.
	if (pool !== undefined || onPoolEvent !== undefined) {
		if (connection === undefined) {
			throw new TypeError(
				'drizzle({pool}): "connection" (DSN or ConnectionOptions) is required when using the pool branch.',
			);
		}
		const created = createPool({ connection, pool, onPoolEvent }) as unknown as TClient;
		return construct(created, drizzleConfig);
	}

	const opts = typeof connection === 'string' ? _parseHanaDSN(connection) : connection!;
	const created = createConnection(opts) as TClient;
	return construct(created, drizzleConfig);
}

export namespace drizzle {
	/**
	 * Returns a no-op SapHanaDatabase. Every driver method resolves with empty data;
	 * transactions, prepared statements, and batch paths are wired through synchronously.
	 * state() / connect() are intentionally omitted — _ensureConnected fast-paths the
	 * missing-connect case.
	 */
	export function mock<
		TSchema extends Record<string, unknown> = Record<string, never>,
		TRelations extends AnyRelations = EmptyRelations,
	>(
		config?: DrizzleConfig<TSchema, TRelations>,
	): SapHanaDatabase<TSchema, TRelations> & {
		$client: '$client is not available on drizzle.mock()';
	} {
		type _MockHanaClient = {
			exec: (sql: string, params: unknown[], cb: (err: Error | null, rows: unknown[]) => void) => void;
			execute: (
				sql: string,
				params: unknown[],
				opts: unknown,
				cb: (err: Error | null, rows: unknown[]) => void,
			) => void;
			prepare: (sql: string, cb: (err: Error | null, stmt: unknown) => void) => void;
			commit: (cb: (err: Error | null) => void) => void;
			rollback: (cb: (err: Error | null) => void) => void;
			setAutoCommit: (v: boolean) => void;
		};
		const noopMock: _MockHanaClient = {
			exec: (_sql, _params, cb) => cb(null, []),
			execute: (_sql, _params, _opts, cb) => cb(null, []),
			prepare: (_sql, cb) =>
				cb(null, {
					exec: (_p: unknown[], scb: (err: Error | null, rows: unknown[]) => void) => scb(null, []),
					execBatch: (_p: unknown[][], scb: (err: Error | null, counts: number[]) => void) => scb(null, [0]),
					drop: () => {},
				}),
			commit: (cb) => cb(null),
			rollback: (cb) => cb(null),
			setAutoCommit: (_v) => {},
		};
		return construct(noopMock as unknown as SapHanaClient, config) as any;
	}
}
