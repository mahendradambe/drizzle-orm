import type { WithCacheConfig } from '~/cache/core/types.ts';
import { entityKind, is } from '~/entity.ts';
import type { HanaDialect } from '~/hana-core/dialect.ts';
import type {
	HanaPreparedQuery,
	HanaQueryResultHKT,
	HanaQueryResultKind,
	HanaSession,
	PreparedQueryConfig,
} from '~/hana-core/session.ts';
import type { HanaTable, TableConfig } from '~/hana-core/table.ts';
import type { TypedQueryBuilder } from '~/query-builders/query-builder.ts';
import { QueryPromise } from '~/query-promise.ts';
import type { RunnableQuery } from '~/runnable-query.ts';
import { SelectionProxyHandler } from '~/selection-proxy.ts';
import type { ColumnsSelection, Placeholder, Query, SQLWrapper } from '~/sql/sql.ts';
import { Param, SQL } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import type { InferInsertModel } from '~/table.ts';
import { getTableName, Table, TableColumns } from '~/table.ts';
import { tracer } from '~/tracing.ts';
import { haveSameKeys } from '~/utils.ts';
import type { AnyHanaColumn } from '../columns/common.ts';
import { extractUsedTable } from '../utils.ts';
import { QueryBuilder } from './query-builder.ts';
import type { SelectedFieldsFlat } from './select.types.ts';

export interface HanaInsertConfig<TTable extends HanaTable = HanaTable> {
	table: TTable;
	values: Record<string, Param | SQL>[] | HanaInsertSelectQueryBuilder<TTable> | SQL;
	withList?: Subquery[];
	returningFields?: SelectedFieldsFlat;
	select?: boolean;
	overridingSystemValue_?: boolean;
}

export type HanaInsertValue<
	TTable extends HanaTable<TableConfig>,
	OverrideT extends boolean = false,
	TModel extends Record<string, any> = InferInsertModel<TTable, { dbColumnNames: false; override: OverrideT }>,
> =
	& {
		[Key in keyof TModel]:
			| TModel[Key]
			| SQL
			| Placeholder;
	}
	& {};

export type HanaInsertSelectQueryBuilder<
	TTable extends HanaTable,
	TModel extends Record<string, any> = InferInsertModel<TTable>,
> = TypedQueryBuilder<
	{ [K in keyof TModel]: AnyHanaColumn | SQL | SQL.Aliased | TModel[K] }
>;

export class HanaInsertBuilder<
	TTable extends HanaTable,
	TQueryResult extends HanaQueryResultHKT,
	OverrideT extends boolean = false,
> {
	static readonly [entityKind]: string = 'HanaInsertBuilder';

	constructor(
		private table: TTable,
		private session: HanaSession,
		private dialect: HanaDialect,
		private withList?: Subquery[],
		private overridingSystemValue_?: boolean,
	) {}

	overridingSystemValue(): Omit<HanaInsertBuilder<TTable, TQueryResult, true>, 'overridingSystemValue'> {
		this.overridingSystemValue_ = true;
		return this as any;
	}

	values(value: HanaInsertValue<TTable, OverrideT>): HanaInsertBase<TTable, TQueryResult>;
	values(values: HanaInsertValue<TTable, OverrideT>[]): HanaInsertBase<TTable, TQueryResult>;
	values(
		values: HanaInsertValue<TTable, OverrideT> | HanaInsertValue<TTable, OverrideT>[],
	): HanaInsertBase<TTable, TQueryResult> {
		values = Array.isArray(values) ? values : [values];
		if (values.length === 0) {
			throw new Error('values() must be called with at least one value');
		}
		const mappedValues = values.map((entry) => {
			const result: Record<string, Param | SQL> = {};
			const cols = this.table[Table.Symbol.Columns];
			for (const colKey of Object.keys(entry)) {
				const colValue = entry[colKey as keyof typeof entry];
				result[colKey] = is(colValue, SQL) ? colValue : new Param(colValue, cols[colKey]);
			}
			return result;
		});

		return new HanaInsertBase(
			this.table,
			mappedValues,
			this.session,
			this.dialect,
			this.withList,
			false,
			this.overridingSystemValue_,
		);
	}

	select(selectQuery: (qb: QueryBuilder) => HanaInsertSelectQueryBuilder<TTable>): HanaInsertBase<TTable, TQueryResult>;
	select(selectQuery: (qb: QueryBuilder) => SQL): HanaInsertBase<TTable, TQueryResult>;
	select(selectQuery: SQL): HanaInsertBase<TTable, TQueryResult>;
	select(selectQuery: HanaInsertSelectQueryBuilder<TTable>): HanaInsertBase<TTable, TQueryResult>;
	select(
		selectQuery:
			| SQL
			| HanaInsertSelectQueryBuilder<TTable>
			| ((qb: QueryBuilder) => HanaInsertSelectQueryBuilder<TTable> | SQL),
	): HanaInsertBase<TTable, TQueryResult> {
		const select = typeof selectQuery === 'function' ? selectQuery(new QueryBuilder()) : selectQuery;

		if (
			!is(select, SQL)
			&& !haveSameKeys(this.table[TableColumns], select._.selectedFields)
		) {
			throw new Error(
				'Insert select error: selected fields are not the same or are in a different order compared to the table definition',
			);
		}

		return new HanaInsertBase(this.table, select, this.session, this.dialect, this.withList, true);
	}
}

export type HanaInsertWithout<T extends AnyHanaInsert, TDynamic extends boolean, K extends keyof T & string> =
	TDynamic extends true ? T
		: Omit<
			HanaInsertBase<
				T['_']['table'],
				T['_']['queryResult'],
				T['_']['selectedFields'],
				TDynamic,
				T['_']['excludedMethods'] | K
			>,
			T['_']['excludedMethods'] | K
		>;

export type HanaInsertPrepare<T extends AnyHanaInsert> = HanaPreparedQuery<
	PreparedQueryConfig & {
		execute: HanaQueryResultKind<T['_']['queryResult'], never>;
	}
>;

export type HanaInsertDynamic<T extends AnyHanaInsert> = HanaInsert<
	T['_']['table'],
	T['_']['queryResult']
>;

export type AnyHanaInsert = HanaInsertBase<any, any, any, any, any>;

export type HanaInsert<
	TTable extends HanaTable = HanaTable,
	TQueryResult extends HanaQueryResultHKT = HanaQueryResultHKT,
	TSelectedFields extends ColumnsSelection | undefined = ColumnsSelection | undefined,
> = HanaInsertBase<TTable, TQueryResult, TSelectedFields, true, never>;

export interface HanaInsertBase<
	TTable extends HanaTable,
	TQueryResult extends HanaQueryResultHKT,
	TSelectedFields extends ColumnsSelection | undefined = undefined,
	TDynamic extends boolean = false,
	TExcludedMethods extends string = never,
> extends
	TypedQueryBuilder<
		TSelectedFields,
		HanaQueryResultKind<TQueryResult, never>
	>,
	QueryPromise<HanaQueryResultKind<TQueryResult, never>>,
	RunnableQuery<HanaQueryResultKind<TQueryResult, never>, 'hana'>,
	SQLWrapper
{
	readonly _: {
		readonly dialect: 'hana';
		readonly table: TTable;
		readonly queryResult: TQueryResult;
		readonly selectedFields: TSelectedFields;
		readonly dynamic: TDynamic;
		readonly excludedMethods: TExcludedMethods;
		readonly result: HanaQueryResultKind<TQueryResult, never>;
	};
}

export class HanaInsertBase<
	TTable extends HanaTable,
	TQueryResult extends HanaQueryResultHKT,
	TSelectedFields extends ColumnsSelection | undefined = undefined,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TDynamic extends boolean = false,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TExcludedMethods extends string = never,
> extends QueryPromise<HanaQueryResultKind<TQueryResult, never>> implements
	TypedQueryBuilder<
		TSelectedFields,
		HanaQueryResultKind<TQueryResult, never>
	>,
	RunnableQuery<HanaQueryResultKind<TQueryResult, never>, 'hana'>,
	SQLWrapper
{
	static override readonly [entityKind]: string = 'HanaInsert';

	private config: HanaInsertConfig<TTable>;
	protected cacheConfig?: WithCacheConfig;

	constructor(
		table: TTable,
		values: HanaInsertConfig['values'],
		private session: HanaSession,
		private dialect: HanaDialect,
		withList?: Subquery[],
		select?: boolean,
		overridingSystemValue_?: boolean,
	) {
		super();
		this.config = { table, values: values as any, withList, select, overridingSystemValue_ };
	}

	/** @internal */
	getSQL(): SQL {
		return this.dialect.buildInsertQuery(this.config);
	}

	toSQL(): Query {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}

	/** @internal */
	_prepare(): HanaInsertPrepare<this> {
		return tracer.startActiveSpan('drizzle.prepareQuery', () => {
			return this.session.prepareQuery<
				PreparedQueryConfig & {
					execute: HanaQueryResultKind<TQueryResult, never>;
				}
			>(this.dialect.sqlToQuery(this.getSQL()), undefined, true, undefined, {
				type: 'insert',
				tables: extractUsedTable(this.config.table),
			}, this.cacheConfig);
		});
	}

	prepare(): HanaInsertPrepare<this> {
		return this._prepare();
	}

	override execute: ReturnType<this['prepare']>['execute'] = (placeholderValues) => {
		return tracer.startActiveSpan('drizzle.operation', () => {
			return this._prepare().execute(placeholderValues);
		});
	};

	/** @internal */
	getSelectedFields(): this['_']['selectedFields'] {
		return (
			this.config.returningFields
				? new Proxy(
					this.config.returningFields,
					new SelectionProxyHandler({
						alias: getTableName(this.config.table),
						sqlAliasedBehavior: 'alias',
						sqlBehavior: 'error',
					}),
				)
				: undefined
		) as this['_']['selectedFields'];
	}

	$dynamic(): HanaInsertDynamic<this> {
		return this as any;
	}
}
