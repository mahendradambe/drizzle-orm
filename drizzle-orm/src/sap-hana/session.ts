import type { Connection, HanaParameterType } from '@sap/hana-client';
import type * as V1 from '~/_relations.ts';
import { type Cache, NoopCache } from '~/cache/core/index.ts';
import type { WithCacheConfig } from '~/cache/core/types.ts';
import { entityKind } from '~/entity.ts';
import type { HanaDialect } from '~/hana-core/dialect.ts';
import { HanaTransaction } from '~/hana-core/index.ts';
import type { SelectedFieldsOrdered } from '~/hana-core/query-builders/select.types.ts';
import type { HanaQueryResultHKT, HanaTransactionConfig, PreparedQueryConfig } from '~/hana-core/session.ts';
import { HanaPreparedQuery, HanaSession } from '~/hana-core/session.ts';
import { type Logger, NoopLogger } from '~/logger.ts';
import type { AnyRelations } from '~/relations.ts';
import { fillPlaceholders, type Query, type SQL, sql } from '~/sql/sql.ts';
import { tracer } from '~/tracing.ts';
import { mapResultRow } from '../utils';
import { _ensureConnected } from './connect-gate.ts';
import type { SapHanaPool } from './pool.ts';

export type SapHanaClient = Connection | SapHanaPool;

/**
 * Duck-type guard for `SapHanaPool`. Reject instanceof / prototype-name fallback
 * (mirrors mysql2's `isPool` pattern; bundler-safe).
 */
export function isSapHanaPool(client: SapHanaClient): client is SapHanaPool {
	return typeof client === 'object'
		&& client !== null
		&& 'acquire' in client
		&& typeof (client as { acquire?: unknown }).acquire === 'function';
}

/**
 * Emit a `release-error` event on the pool when release() rejects inside `finally`.
 * Reaches into the pool's private `_emit` deliberately (audit M3) — observability
 * MUST NOT block the original tx outcome. Try/catch-wrapped: hook failures swallowed.
 */
function _emitReleaseError(pool: SapHanaPool, err: unknown, conn: Connection): void {
	try {
		const emit = (pool as unknown as { _emit?: (e: string, m: object) => void })._emit;
		if (typeof emit === 'function') {
			emit.call(pool, 'release-error', { err: err as Error, conn });
		}
	} catch {
		// observability isolation — never throw from finally cleanup
	}
}

/**
 * Pool acquire-timeout normalized error code.
 *
 * @stability stable since 1.0.0-beta.5 — string value MUST NOT change in any minor/patch release.
 */
export const HANA_POOL_ACQUIRE_TIMEOUT = 'HANA_POOL_ACQUIRE_TIMEOUT' as const;

/**
 * Pool connection-dead normalized error code. Surfaces when the driver returns
 * either of the following `code + sqlState` pairs:
 *  - `errCode -20006 / sqlState 'HY000'` — pool-internal stale-conn (native pool's
 *    "No Connection Available" path).
 *  - `errCode -10807 / sqlState 'HY000'` — server-side `ALTER SYSTEM DISCONNECT
 *    SESSION` (admin-initiated; coverage added in `1.0.0-beta.6`).
 *
 * Raw driver code is preserved on the wrapped error's `driverErrCode` field.
 *
 * @stability stable since 1.0.0-beta.5 — string value MUST NOT change in any minor/patch release.
 */
export const HANA_POOL_CONNECTION_DEAD = 'HANA_POOL_CONNECTION_DEAD' as const;

interface HanaDriverError extends Error {
	code?: number | string;
	sqlState?: string;
	query?: string;
	params?: unknown[];
	driverErrCode?: number;
	driverMessage?: string;
	[k: string]: unknown;
}

export function _normalizeHanaError(
	err: unknown,
	context: { query?: string; params?: unknown[] },
): HanaDriverError {
	const isErrorLike = err !== null
		&& typeof err === 'object'
		&& 'message' in err
		&& 'name' in err;
	if (!isErrorLike) {
		const wrapped = new Error(String(err)) as HanaDriverError;
		if (context.query !== undefined) wrapped.query = context.query;
		if (context.params !== undefined) wrapped.params = context.params;
		return wrapped;
	}
	const errObj = err as Error;
	const wrapped = new Error(errObj.message) as HanaDriverError;
	wrapped.name = errObj.name || 'HanaError';
	wrapped.stack = errObj.stack;
	for (const key of Object.getOwnPropertyNames(errObj)) {
		if (key === 'message' || key === 'stack' || key === 'name') continue;
		(wrapped as Record<string, unknown>)[key] = (errObj as unknown as Record<string, unknown>)[key];
	}
	if (context.query !== undefined) wrapped.query = context.query;
	if (context.params !== undefined) wrapped.params = context.params;
	(wrapped as Record<string, unknown>)['cause'] = errObj;

	// Conn-dead detection: PRIMARY match on `code + sqlState` (driver-version-stable).
	// Two driver code paths share sqlState='HY000':
	//   -20006 → pool-internal stale-conn (native pool's "No Connection Available" path)
	//   -10807 → server-side ALTER SYSTEM DISCONNECT SESSION (admin-initiated)
	// Both normalize to HANA_POOL_CONNECTION_DEAD. Raw driver code preserved in driverErrCode.
	// Locale-coupling risk: HANA error messages may be localized; matching on
	// err.code+sqlState (not message) is stable across locales.
	// Re-verify under HANA Cloud cross-tenant (release-gate workstream).
	const errRec = err as unknown as Record<string, unknown>;
	const numericCode = typeof errRec['code'] === 'number' ? (errRec['code'] as number) : undefined;
	const sqlState = typeof errRec['sqlState'] === 'string' ? (errRec['sqlState'] as string) : undefined;
	if (sqlState === 'HY000' && (numericCode === -20006 || numericCode === -10807)) {
		wrapped.driverErrCode = numericCode;
		wrapped.driverMessage = err.message;
		wrapped.code = HANA_POOL_CONNECTION_DEAD;
	}

	// Pass-through: pool acquire-timeout is produced directly by SapHanaPool.acquire().
	// _normalizeHanaError preserves the code already set.
	if (errRec['code'] === HANA_POOL_ACQUIRE_TIMEOUT) {
		wrapped.code = HANA_POOL_ACQUIRE_TIMEOUT;
	}

	return wrapped;
}

export class SapHanaPreparedQuery<T extends PreparedQueryConfig, TIsRqbV2 extends boolean = false>
	extends HanaPreparedQuery<T>
{
	static override readonly [entityKind]: string = 'SapHanaPreparedQuery';

	constructor(
		private client: SapHanaClient,
		private queryString: string,
		private params: unknown[],
		private logger: Logger,
		cache: Cache,
		queryMetadata: {
			type: 'select' | 'update' | 'delete' | 'insert';
			tables: string[];
		} | undefined,
		cacheConfig: WithCacheConfig | undefined,
		private fields: SelectedFieldsOrdered | undefined,
		private _isResponseInArrayMode: boolean,
		private customResultMapper?: (
			rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][],
		) => T['execute'],
		private isRqbV2Query?: TIsRqbV2,
	) {
		super({ sql: queryString, params }, cache, queryMetadata, cacheConfig);
	}

	async execute(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['execute']> {
		if (this.isRqbV2Query) return this.executeRqbV2(placeholderValues);

		// Statement-scope pool acquire (per-call; no session-instance storage).
		let acquiredConn: Connection | undefined = undefined;
		const conn: Connection = isSapHanaPool(this.client)
			? (acquiredConn = await this.client.acquire())
			: (this.client as Connection);
		try {
			// _CONNECT_GATE: lazy connect — covers ALL drizzle paths because
			// db.select/insert/update/delete/execute all funnel through prepareQuery
			// → SapHanaPreparedQuery.execute (M1 audit constraint).
			await _ensureConnected(conn);

			return await tracer.startActiveSpan('drizzle.execute', async () => {
				const params = fillPlaceholders(this.params, placeholderValues) as HanaParameterType[];

				this.logger.logQuery(this.queryString, params);

				const { fields, queryString, customResultMapper, joinsNotNullableMap } = this;

				if (!fields && !customResultMapper) {
					return tracer.startActiveSpan('drizzle.driver.execute', async (span) => {
						span?.setAttributes({
							'drizzle.query.text': queryString,
							'drizzle.query.params': JSON.stringify(params),
						});
						return this.queryWithCache(queryString, params, async () => {
							return await new Promise((resolve, reject) => {
								conn.execute(queryString, params, { rowsAsArray: true }, (err, res) => {
									if (err) {
										reject(_normalizeHanaError(err, { query: queryString, params }));
									}

									resolve(res);
								});
							});
						});
					});
				}

				const result = await tracer.startActiveSpan('drizzle.driver.execute', (span) => {
					span?.setAttributes({
						'drizzle.query.text': queryString,
						'drizzle.query.params': JSON.stringify(params),
					});
					return this.queryWithCache(queryString, params, async () => {
						return await new Promise<any[]>((resolve, reject) => {
							conn.execute(queryString, params, { rowsAsArray: true }, (err, res) => {
								if (err) {
									reject(_normalizeHanaError(err, { query: queryString, params }));
								}

								resolve(res as any[]);
							});
						});
					});
				});

				return tracer.startActiveSpan('drizzle.mapResponse', () => {
					return customResultMapper
						? (customResultMapper as (rows: unknown[][]) => T['execute'])(result)
						: result.map((row) => mapResultRow<T['execute']>(fields!, row, joinsNotNullableMap));
				});
			});
		} finally {
			if (acquiredConn !== undefined && isSapHanaPool(this.client)) {
				try {
					await this.client.release(acquiredConn);
				} catch (releaseErr) {
					_emitReleaseError(this.client, releaseErr, acquiredConn);
				} finally {
					acquiredConn = undefined;
				}
			}
		}
	}

	private async executeRqbV2(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['execute']> {
		let acquiredConn: Connection | undefined = undefined;
		const conn: Connection = isSapHanaPool(this.client)
			? (acquiredConn = await this.client.acquire())
			: (this.client as Connection);
		try {
			await _ensureConnected(conn);

			return await tracer.startActiveSpan('drizzle.execute', async () => {
				const params = fillPlaceholders(this.params, placeholderValues);

				this.logger.logQuery(this.query.sql, params);

				const { queryString, customResultMapper } = this;

				const result = await tracer.startActiveSpan('drizzle.driver.execute', (span) => {
					span?.setAttributes({
						'drizzle.query.text': queryString,
						'drizzle.query.params': JSON.stringify(params),
					});

					return new Promise((resolve, reject) => {
						conn.exec(queryString, params, (err, res) => {
							if (err) {
								reject(_normalizeHanaError(err, { query: queryString, params }));
							}

							resolve(res);
						});
					});
				});

				return tracer.startActiveSpan('drizzle.mapResponse', () => {
					return (customResultMapper as (rows: Record<string, unknown>[]) => T['execute'])(result as any[]);
				});
			});
		} finally {
			if (acquiredConn !== undefined && isSapHanaPool(this.client)) {
				try {
					await this.client.release(acquiredConn);
				} catch (releaseErr) {
					_emitReleaseError(this.client, releaseErr, acquiredConn);
				} finally {
					acquiredConn = undefined;
				}
			}
		}
	}

	all(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['all']> {
		return tracer.startActiveSpan('drizzle.execute', async () => {
			let acquiredConn: Connection | undefined;
			const conn: Connection = isSapHanaPool(this.client)
				? (acquiredConn = await this.client.acquire())
				: (this.client as Connection);
			try {
				await _ensureConnected(conn);
				const params = fillPlaceholders(this.params, placeholderValues);
				this.logger.logQuery(this.queryString, params);
				return await tracer.startActiveSpan('drizzle.driver.execute', (span) => {
					span?.setAttributes({
						'drizzle.query.text': this.queryString,
						'drizzle.query.params': JSON.stringify(params),
					});
					return this.queryWithCache(this.queryString, params, async () => {
						return new Promise((resolve, reject) => {
							conn.exec(this.queryString, params, (err, res) => {
								if (err) {
									return reject(_normalizeHanaError(err, { query: this.queryString, params }));
								}

								resolve(res);
							});
						});
					});
				});
			} finally {
				if (acquiredConn !== undefined && isSapHanaPool(this.client)) {
					try {
						await this.client.release(acquiredConn);
					} catch (releaseErr) {
						_emitReleaseError(this.client, releaseErr, acquiredConn);
					} finally {
						acquiredConn = undefined;
					}
				}
			}
		});
	}

	/** @internal */
	isResponseInArrayMode(): boolean {
		return this._isResponseInArrayMode;
	}
}

export interface SapHanaSessionOptions {
	logger?: Logger;
	cache?: Cache;
}

export class SapHanaSession<
	TFullSchema extends Record<string, unknown>,
	TRelations extends AnyRelations,
	TSchema extends V1.TablesRelationalConfig,
> extends HanaSession<SapHanaQueryResultHKT, TFullSchema, TRelations, TSchema> {
	static override readonly [entityKind]: string = 'SapHanaSession';

	private logger: Logger;
	private cache: Cache;

	constructor(
		private client: SapHanaClient,
		dialect: HanaDialect,
		private relations: TRelations,
		private schema: V1.RelationalSchemaConfig<TSchema> | undefined,
		private options: SapHanaSessionOptions = {},
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.cache = options.cache ?? new NoopCache();
	}

	prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		isResponseInArrayMode: boolean,
		customResultMapper?: (rows: unknown[][]) => T['execute'],
		queryMetadata?: {
			type: 'select' | 'update' | 'delete' | 'insert';
			tables: string[];
		},
		cacheConfig?: WithCacheConfig,
	): HanaPreparedQuery<T> {
		return new SapHanaPreparedQuery(
			this.client,
			query.sql,
			query.params,
			this.logger,
			this.cache,
			queryMetadata,
			cacheConfig,
			fields,
			isResponseInArrayMode,
			customResultMapper,
		);
	}

	prepareRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		customResultMapper?: (rows: Record<string, unknown>[]) => T['execute'],
	): HanaPreparedQuery<T> {
		return new SapHanaPreparedQuery(
			this.client,
			query.sql,
			query.params,
			this.logger,
			this.cache,
			undefined,
			undefined,
			fields,
			false,
			customResultMapper,
			true,
		);
	}

	async executeBatch(queryString: string, paramRows: unknown[][]): Promise<unknown> {
		let acquiredConn: Connection | undefined = undefined;
		const conn: Connection = isSapHanaPool(this.client)
			? (acquiredConn = await this.client.acquire())
			: (this.client as Connection);
		try {
			await _ensureConnected(conn);
			this.logger.logQuery(queryString, []);
			return await tracer.startActiveSpan('drizzle.execute', async (span) => {
				span?.setAttributes({
					'drizzle.query.text': queryString,
					'drizzle.query.params': JSON.stringify(paramRows),
				});
				return new Promise((resolve, reject) => {
					conn.prepare(queryString, (err: Error | null, stmt: any) => {
						if (err) return reject(_normalizeHanaError(err, { query: queryString, params: paramRows as unknown[] }));
						stmt.execBatch(paramRows as HanaParameterType[][], (err: Error | null, result: any) => {
							stmt.drop();
							if (err) {
								return reject(_normalizeHanaError(err, { query: queryString, params: paramRows as unknown[] }));
							}
							resolve(result);
						});
					});
				});
			});
		} finally {
			if (acquiredConn !== undefined && isSapHanaPool(this.client)) {
				try {
					await this.client.release(acquiredConn);
				} catch (releaseErr) {
					_emitReleaseError(this.client, releaseErr, acquiredConn);
				} finally {
					acquiredConn = undefined;
				}
			}
		}
	}

	/**
	 * @remarks
	 * When the session's `client` is a `SapHanaPool`, each `transaction()` invocation
	 * acquires its OWN connection from the pool at entry and releases it in `finally`
	 * (after autoCommit restore). Concurrent `transaction()` calls each get a distinct
	 * pooled conn — no session-instance conn storage.
	 *
	 * When `client` is a raw `Connection`, single-transaction-per-connection still holds —
	 * concurrent calls on the same session race the autocommit toggle.
	 */
	override async transaction<T>(
		transaction: (tx: SapHanaTransaction<TFullSchema, TRelations, TSchema>) => Promise<T>,
		config?: HanaTransactionConfig | undefined,
	): Promise<T> {
		// Pre-flight: HANA rejects READ UNCOMMITTED (errCode 7 feature-not-supported).
		// Per-value gating. Must fire BEFORE
		// any driver call so no SQL leaks and setAutoCommit is not toggled on bypass.
		if (
			typeof config?.isolationLevel === 'string'
			&& config.isolationLevel.toLowerCase() === 'read uncommitted'
		) {
			const err = new Error(
				'HANA does not support READ UNCOMMITTED isolation level (errCode 7: feature not supported). Use read committed | repeatable read | serializable.',
			);
			(err as any).code = 'HANA_ISOLATION_READ_UNCOMMITTED_UNSUPPORTED';
			throw err;
		}

		// Acquire BEFORE entering try; on acquire-rejection the user `cb`
		// is NEVER invoked and no setAutoCommit/pre-tx SQL is emitted on a leaked conn.
		let acquiredConn: Connection | undefined = undefined;
		const conn: Connection = isSapHanaPool(this.client)
			? (acquiredConn = await this.client.acquire())
			: (this.client as Connection);

		try {
			// _CONNECT_GATE: lazy connect covers the sync `setAutoCommit(false)` below
			// (Proxy can only gate async callback methods). Must run AFTER the
			// pre-flight reject (no connect attempt on a guaranteed-reject path).
			await _ensureConnected(conn);

			// Bind a fresh session to the acquired conn so PreparedQuery/executeBatch routed
			// through tx use `conn` directly (skip another acquire). No shared mut state.
			const txSession = new SapHanaSession<TFullSchema, TRelations, TSchema>(
				conn,
				this.dialect,
				this.relations,
				this.schema,
				this.options,
			);
			const tx = new SapHanaTransaction<TFullSchema, TRelations, TSchema>(
				this.dialect,
				txSession,
				this.relations,
				this.schema,
			);

			try {
				// setAutoCommit + pre-tx emissions are INSIDE the try so finally restores
				// setAutoCommit(true) even if any emission throws (M2 failure-mode coverage).
				conn.setAutoCommit(false);

				// DDL inside the user tx must participate in commit/rollback.
				await new Promise<void>((resolve, reject) => {
					conn.exec('SET TRANSACTION AUTOCOMMIT DDL OFF', [], (err) =>
						err
							? reject(_normalizeHanaError(err, { query: 'SET TRANSACTION AUTOCOMMIT DDL OFF' }))
							: resolve());
				});

				if (config?.isolationLevel !== undefined) {
					// HANA silently promotes REPEATABLE READ to SERIALIZABLE
					// (observable via M_TRANSACTIONS.ISOLATION_LEVEL).
					const isoSqlMap = {
						'read committed': 'READ COMMITTED',
						'repeatable read': 'REPEATABLE READ',
						serializable: 'SERIALIZABLE',
					} as const;
					const isoSql = isoSqlMap[config.isolationLevel];
					const isoStmt = `SET TRANSACTION ISOLATION LEVEL ${isoSql}`;
					await new Promise<void>((resolve, reject) => {
						conn.exec(isoStmt, [], (err) => err ? reject(_normalizeHanaError(err, { query: isoStmt })) : resolve());
					});
				}

				if (config?.accessMode !== undefined) {
					// Must emit AFTER setAutoCommit(false) — outside an active tx
					// the per-tx scope is ambiguous (parse-accepted but not enforced).
					const amStmt = config.accessMode === 'read only'
						? 'SET TRANSACTION READ ONLY'
						: 'SET TRANSACTION READ WRITE';
					await new Promise<void>((resolve, reject) => {
						conn.exec(amStmt, [], (err) => err ? reject(_normalizeHanaError(err, { query: amStmt })) : resolve());
					});
				}

				const result = await transaction(tx);
				await new Promise<void>((resolve, reject) => {
					conn.commit((err) => (err ? reject(_normalizeHanaError(err, { query: 'COMMIT' })) : resolve()));
				});
				return result;
			} catch (error) {
				await new Promise<void>((resolve, reject) => {
					conn.rollback((err) => (err ? reject(_normalizeHanaError(err, { query: 'ROLLBACK' })) : resolve()));
				});
				throw error;
			} finally {
				try {
					conn.setAutoCommit(true);
				} catch (restoreErr) {
					this.logger.logQuery('[sap-hana] setAutoCommit(true) restoration failed', [restoreErr as any]);
				}
			}
		} finally {
			// Release in finally with conn-undefined guard. release errors
			// route to onPoolEvent('release-error') WITHOUT throwing — preserves original tx outcome.
			if (acquiredConn !== undefined && isSapHanaPool(this.client)) {
				try {
					await this.client.release(acquiredConn);
				} catch (releaseErr) {
					_emitReleaseError(this.client, releaseErr, acquiredConn);
				} finally {
					acquiredConn = undefined;
				}
			}
		}
	}

	override async count(sql: SQL): Promise<number> {
		const res = await this.execute<{ rows: [{ count: string }] }>(sql);
		return Number(
			res['rows'][0]['count'],
		);
	}
}

export class SapHanaTransaction<
	TFullSchema extends Record<string, unknown>,
	TRelations extends AnyRelations,
	TSchema extends V1.TablesRelationalConfig,
> extends HanaTransaction<SapHanaQueryResultHKT, TFullSchema, TRelations, TSchema> {
	static override readonly [entityKind]: string = 'SapHanaTransaction';

	override async transaction<T>(
		transaction: (tx: SapHanaTransaction<TFullSchema, TRelations, TSchema>) => Promise<T>,
	): Promise<T> {
		const savepointName = `sp${this.nestedIndex + 1}`;
		const tx = new SapHanaTransaction<TFullSchema, TRelations, TSchema>(
			this.dialect,
			this.session,
			this.relations,
			this.schema,
			this.nestedIndex + 1,
		);
		await tx.execute(sql.raw(`savepoint ${savepointName}`));
		try {
			const result = await transaction(tx);
			await tx.execute(sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
}

export interface SapHanaQueryResultHKT extends HanaQueryResultHKT {
	type: this['row'][];
}
