import { entityKind } from '~/entity.ts';
import { QueryPromise } from '~/query-promise.ts';
import {
	type BuildQueryResult,
	type BuildRelationalQueryResult,
	type DBQueryConfig,
	mapRelationalRow,
	type TableRelationalConfig,
	type TablesRelationalConfig,
} from '~/relations.ts';
import type { RunnableQuery } from '~/runnable-query.ts';
import type { Query, QueryWithTypings, SQL, SQLWrapper } from '~/sql/sql.ts';
import { tracer } from '~/tracing.ts';
import type { KnownKeysOnly } from '~/utils.ts';
import type { HanaDialect } from '../dialect.ts';
import type { HanaPreparedQuery, HanaSession, PreparedQueryConfig } from '../session.ts';
import type { HanaTable } from '../table.ts';

export class RelationalQueryBuilder<
	TSchema extends TablesRelationalConfig,
	TFields extends TableRelationalConfig,
> {
	static readonly [entityKind]: string = 'HanaRelationalQueryBuilderV2';

	constructor(
		private schema: TSchema,
		private table: HanaTable,
		private tableConfig: TableRelationalConfig,
		private dialect: HanaDialect,
		private session: HanaSession,
		private parseJson: boolean,
	) {}

	findMany<TConfig extends DBQueryConfig<'many', TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, DBQueryConfig<'many', TSchema, TFields>>,
	): HanaRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig>[]> {
		return new HanaRelationalQuery(
			this.schema,
			this.table,
			this.tableConfig,
			this.dialect,
			this.session,
			config as DBQueryConfig<'many'> | undefined ?? true,
			'many',
			this.parseJson,
		);
	}

	findFirst<TConfig extends DBQueryConfig<'one', TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, DBQueryConfig<'one', TSchema, TFields>>,
	): HanaRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig> | undefined> {
		return new HanaRelationalQuery(
			this.schema,
			this.table,
			this.tableConfig,
			this.dialect,
			this.session,
			config as DBQueryConfig<'one'> | undefined ?? true,
			'first',
			this.parseJson,
		);
	}
}

export class HanaRelationalQuery<TResult> extends QueryPromise<TResult>
	implements RunnableQuery<TResult, 'hana'>, SQLWrapper
{
	static override readonly [entityKind]: string = 'HanaRelationalQueryV2';

	declare readonly _: {
		readonly dialect: 'hana';
		readonly result: TResult;
	};

	constructor(
		private schema: TablesRelationalConfig,
		private table: HanaTable,
		private tableConfig: TableRelationalConfig,
		private dialect: HanaDialect,
		private session: HanaSession,
		private config: DBQueryConfig<'many' | 'one'> | true,
		private mode: 'many' | 'first',
		private parseJson: boolean,
	) {
		super();
	}

	/** @internal */
	_prepare(): HanaPreparedQuery<PreparedQueryConfig & { execute: TResult }> {
		return tracer.startActiveSpan('drizzle.prepareQuery', () => {
			const { query, builtQuery } = this._toSQL();

			return this.session.prepareRelationalQuery<PreparedQueryConfig & { execute: TResult }>(
				builtQuery,
				undefined,
				(rawRows, mapColumnValue) => {
					const rows = rawRows.map((row) =>
						mapRelationalRow(row, true, query.selection, mapColumnValue, this.parseJson, true) as Record<
							string,
							unknown
						>
					);
					if (this.mode === 'first') {
						return rows[0] as TResult;
					}
					return rows as TResult;
				},
			);
		});
	}

	prepare(): HanaPreparedQuery<PreparedQueryConfig & { execute: TResult }> {
		return this._prepare();
	}

	private _getQuery() {
		return this.dialect.buildRelationalQuery({
			schema: this.schema,
			table: this.table,
			tableConfig: this.tableConfig,
			queryConfig: this.config,
			mode: this.mode,
		});
	}

	/** @internal */
	getSQL(): SQL {
		return this._getQuery().sql;
	}

	private _toSQL(): { query: BuildRelationalQueryResult; builtQuery: QueryWithTypings } {
		const query = this._getQuery();

		const builtQuery = this.dialect.sqlToQuery(query.sql);

		return { query, builtQuery };
	}

	toSQL(): Query {
		return this._toSQL().builtQuery;
	}

	override execute(): Promise<TResult> {
		return tracer.startActiveSpan('drizzle.operation', () => {
			return this._prepare().execute(undefined);
		});
	}
}
