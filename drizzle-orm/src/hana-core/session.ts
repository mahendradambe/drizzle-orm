import type * as V1 from '~/_relations.ts';
import { type Cache, hashQuery, NoopCache } from '~/cache/core/cache.ts';
import type { WithCacheConfig } from '~/cache/core/types.ts';
import { entityKind, is } from '~/entity.ts';
import { DrizzleQueryError, TransactionRollbackError } from '~/errors.ts';
import type { AnyRelations, EmptyRelations } from '~/relations.ts';
import type { PreparedQuery } from '~/session.ts';
import { type Query, type SQL, sql } from '~/sql/index.ts';
import { tracer } from '~/tracing.ts';
import { HanaDatabase } from './db.ts';
import type { HanaDialect } from './dialect.ts';
import type { SelectedFieldsOrdered } from './query-builders/select.types.ts';

export interface PreparedQueryConfig {
	execute: unknown;
	all: unknown;
	values: unknown;
}

export abstract class HanaPreparedQuery<T extends PreparedQueryConfig> implements PreparedQuery {
	constructor(
		protected query: Query,
		// cache instance
		private cache: Cache | undefined,
		// per query related metadata
		private queryMetadata: {
			type: 'select' | 'update' | 'delete' | 'insert';
			tables: string[];
		} | undefined,
		// config that was passed through $withCache
		private cacheConfig?: WithCacheConfig,
	) {
		// it means that no $withCache options were passed and it should be just enabled
		if (cache && cache.strategy() === 'all' && cacheConfig === undefined) {
			this.cacheConfig = { enable: true, autoInvalidate: true };
		}
		if (!this.cacheConfig?.enable) {
			this.cacheConfig = undefined;
		}
	}

	getQuery(): Query {
		return this.query;
	}

	mapResult(response: unknown, _isFromBatch?: boolean): unknown {
		return response;
	}

	static readonly [entityKind]: string = 'HanaPreparedQuery';

	/** @internal */
	joinsNotNullableMap?: Record<string, boolean>;

	/** @internal */
	protected async queryWithCache<T>(
		queryString: string,
		params: any[],
		query: () => Promise<T>,
	): Promise<T> {
		if (this.cache === undefined || is(this.cache, NoopCache) || this.queryMetadata === undefined) {
			try {
				return await query();
			} catch (e) {
				throw new DrizzleQueryError(queryString, params, e as Error);
			}
		}

		// don't do any mutations, if globally is false
		if (this.cacheConfig && !this.cacheConfig.enable) {
			try {
				return await query();
			} catch (e) {
				throw new DrizzleQueryError(queryString, params, e as Error);
			}
		}

		// For mutate queries, we should query the database, wait for a response, and then perform invalidation
		if (
			(
				this.queryMetadata.type === 'insert' || this.queryMetadata.type === 'update'
				|| this.queryMetadata.type === 'delete'
			) && this.queryMetadata.tables.length > 0
		) {
			try {
				const [res] = await Promise.all([
					query(),
					this.cache.onMutate({ tables: this.queryMetadata.tables }),
				]);
				return res;
			} catch (e) {
				throw new DrizzleQueryError(queryString, params, e as Error);
			}
		}

		// don't do any reads if globally disabled
		if (!this.cacheConfig) {
			try {
				return await query();
			} catch (e) {
				throw new DrizzleQueryError(queryString, params, e as Error);
			}
		}

		if (this.queryMetadata.type === 'select') {
			const fromCache = await this.cache.get(
				this.cacheConfig.tag ?? await hashQuery(queryString, params),
				this.queryMetadata.tables,
				this.cacheConfig.tag !== undefined,
				this.cacheConfig.autoInvalidate,
			);
			if (fromCache === undefined) {
				let result;
				try {
					result = await query();
				} catch (e) {
					throw new DrizzleQueryError(queryString, params, e as Error);
				}
				// put actual key
				await this.cache.put(
					this.cacheConfig.tag ?? await hashQuery(queryString, params),
					result,
					// make sure we send tables that were used in a query only if user wants to invalidate it on each write
					this.cacheConfig.autoInvalidate ? this.queryMetadata.tables : [],
					this.cacheConfig.tag !== undefined,
					this.cacheConfig.config,
				);
				// put flag if we should invalidate or not
				return result;
			}

			return fromCache as unknown as T;
		}
		try {
			return await query();
		} catch (e) {
			throw new DrizzleQueryError(queryString, params, e as Error);
		}
	}

	abstract execute(placeholderValues?: Record<string, unknown>): Promise<T['execute']>;
	/** @internal */
	abstract execute(placeholderValues?: Record<string, unknown>): Promise<T['execute']>;
	/** @internal */
	abstract execute(placeholderValues?: Record<string, unknown>): Promise<T['execute']>;

	/** @internal */
	abstract all(placeholderValues?: Record<string, unknown>): Promise<T['all']>;

	/** @internal */
	abstract isResponseInArrayMode(): boolean;
}

export interface HanaTransactionConfig {
	isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
	accessMode?: 'read only' | 'read write';
}

export abstract class HanaSession<
	TQueryResult extends HanaQueryResultHKT = HanaQueryResultHKT,
	TFullSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
	TSchema extends V1.TablesRelationalConfig = V1.ExtractTablesWithRelations<TFullSchema>,
> {
	static readonly [entityKind]: string = 'HanaSession';

	constructor(protected dialect: HanaDialect) {}

	abstract prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		isResponseInArrayMode: boolean,
		customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => T['execute'],
		queryMetadata?: {
			type: 'select' | 'update' | 'delete' | 'insert';
			tables: string[];
		},
		cacheConfig?: WithCacheConfig,
	): HanaPreparedQuery<T>;

	abstract prepareRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		customResultMapper: (
			rows: Record<string, unknown>[],
			mapColumnValue?: (value: unknown) => unknown,
		) => T['execute'],
	): HanaPreparedQuery<T>;

	execute<T>(query: SQL): Promise<T>;
	/** @internal */
	execute<T>(query: SQL): Promise<T>;
	/** @internal */
	execute<T>(query: SQL): Promise<T> {
		return tracer.startActiveSpan('drizzle.operation', () => {
			const prepared = tracer.startActiveSpan('drizzle.prepareQuery', () => {
				return this.prepareQuery<PreparedQueryConfig & { execute: T }>(
					this.dialect.sqlToQuery(query),
					undefined,
					false,
				);
			});

			return prepared.execute(undefined);
		});
	}

	abstract executeBatch(sql: string, paramRows: unknown[][]): Promise<unknown>;

	all<T = unknown>(query: SQL): Promise<T[]> {
		return this.prepareQuery<PreparedQueryConfig & { all: T[] }>(
			this.dialect.sqlToQuery(query),
			undefined,
			false,
		).all();
	}

	/** @internal */
	async count(sql: SQL): Promise<number> {
		const res = await this.execute<[{ count: string }]>(sql);

		return Number(
			res[0]['count'],
		);
	}

	abstract transaction<T>(
		transaction: (tx: HanaTransaction<TQueryResult, TFullSchema, TRelations, TSchema>) => Promise<T>,
		config?: HanaTransactionConfig,
	): Promise<T>;
}

export abstract class HanaTransaction<
	TQueryResult extends HanaQueryResultHKT,
	TFullSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
	TSchema extends V1.TablesRelationalConfig = V1.ExtractTablesWithRelations<TFullSchema>,
> extends HanaDatabase<TQueryResult, TFullSchema, TRelations, TSchema> {
	static override readonly [entityKind]: string = 'HanaTransaction';

	constructor(
		dialect: HanaDialect,
		session: HanaSession<any, any, any, any>,
		protected relations: TRelations,
		protected schema: {
			fullSchema: Record<string, unknown>;
			schema: TSchema;
			tableNamesMap: Record<string, string>;
		} | undefined,
		protected readonly nestedIndex = 0,
		parseRqbJson?: boolean,
	) {
		super(dialect, session, relations, schema, parseRqbJson);
	}

	rollback(): never {
		throw new TransactionRollbackError();
	}

	/** @internal */
	getTransactionConfigSQL(config: HanaTransactionConfig): SQL {
		const chunks: string[] = [];
		if (config.isolationLevel) {
			chunks.push(`isolation level ${config.isolationLevel}`);
		}
		if (config.accessMode) {
			chunks.push(config.accessMode);
		}
		return sql.raw(chunks.join(' '));
	}

	setTransaction(config: HanaTransactionConfig): Promise<void> {
		return this.session.execute(sql`set transaction ${this.getTransactionConfigSQL(config)}`);
	}

	abstract override transaction<T>(
		transaction: (tx: HanaTransaction<TQueryResult, TFullSchema, TRelations, TSchema>) => Promise<T>,
	): Promise<T>;
}

export interface HanaQueryResultHKT {
	readonly $brand: 'HanaQueryResultHKT';
	readonly row: unknown;
	readonly type: unknown;
}

export type HanaQueryResultKind<TKind extends HanaQueryResultHKT, TRow> = (TKind & {
	readonly row: TRow;
})['type'];
