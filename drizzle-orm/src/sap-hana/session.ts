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

export type SapHanaClient = Connection;

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

		return tracer.startActiveSpan('drizzle.execute', async () => {
			const params = fillPlaceholders(this.params, placeholderValues) as HanaParameterType[];

			this.logger.logQuery(this.queryString, params);

			const { fields, client, queryString, customResultMapper, joinsNotNullableMap } = this;

			if (!fields && !customResultMapper) {
				return tracer.startActiveSpan('drizzle.driver.execute', async (span) => {
					span?.setAttributes({
						'drizzle.query.text': queryString,
						'drizzle.query.params': JSON.stringify(params),
					});
					return this.queryWithCache(queryString, params, async () => {
						return await new Promise((resolve, reject) => {
							client.execute(queryString, params, { rowsAsArray: true }, (err, res) => {
								if (err) {
									reject(err);
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
						client.execute(queryString, params, { rowsAsArray: true }, (err, res) => {
							if (err) {
								reject(err);
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
	}

	private async executeRqbV2(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['execute']> {
		return tracer.startActiveSpan('drizzle.execute', async () => {
			const params = fillPlaceholders(this.params, placeholderValues);

			this.logger.logQuery(this.query.sql, params);

			const { queryString, client, customResultMapper } = this;

			const result = await tracer.startActiveSpan('drizzle.driver.execute', (span) => {
				span?.setAttributes({
					'drizzle.query.text': queryString,
					'drizzle.query.params': JSON.stringify(params),
				});

				return new Promise((resolve, reject) => {
					client.exec(queryString, params, (err, res) => {
						if (err) {
							reject(err);
						}

						resolve(res);
					});
				});
			});

			return tracer.startActiveSpan('drizzle.mapResponse', () => {
				return (customResultMapper as (rows: Record<string, unknown>[]) => T['execute'])(result as any[]);
			});
		});
	}

	all(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['all']> {
		return tracer.startActiveSpan('drizzle.execute', () => {
			const params = fillPlaceholders(this.params, placeholderValues);
			this.logger.logQuery(this.queryString, params);
			return tracer.startActiveSpan('drizzle.driver.execute', (span) => {
				span?.setAttributes({
					'drizzle.query.text': this.queryString,
					'drizzle.query.params': JSON.stringify(params),
				});
				return this.queryWithCache(this.queryString, params, async () => {
					return new Promise((resolve, reject) => {
						this.client.exec(this.queryString, params, (err, res) => {
							if (err) {
								return reject(err);
							}

							resolve(res);
						});
					});
				});
			});
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
		this.logger.logQuery(queryString, []);
		return tracer.startActiveSpan('drizzle.execute', async (span) => {
			span?.setAttributes({
				'drizzle.query.text': queryString,
				'drizzle.query.params': JSON.stringify(paramRows),
			});
			return new Promise((resolve, reject) => {
				this.client.prepare(queryString, (err: Error | null, stmt: any) => {
					if (err) return reject(err);
					stmt.execBatch(paramRows as HanaParameterType[][], (err: Error | null, result: any) => {
						stmt.drop();
						if (err) return reject(err);
						resolve(result);
					});
				});
			});
		});
	}

	override async transaction<T>(
		transaction: (tx: SapHanaTransaction<TFullSchema, TRelations, TSchema>) => Promise<T>,
		config?: HanaTransactionConfig | undefined,
	): Promise<T> {
		const session = this;
		const tx = new SapHanaTransaction<TFullSchema, TRelations, TSchema>(
			this.dialect,
			session,
			this.relations,
			this.schema,
		);

		await this.startTransaction(true);

		// TODO: handle isolation level

		try {
			const result = await transaction(tx);
			await tx.execute(sql`commit`);
			return result;
		} catch (error) {
			await tx.execute(sql`rollback`);
			throw error;
		}
	}

	async startTransaction(enabled: true) {
		this.client.setAutoCommit(enabled);
		await this.client.exec(`SET TRANSACTION AUTOCOMMIT DDL ${enabled ? 'ON' : 'OFF'}`);
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
