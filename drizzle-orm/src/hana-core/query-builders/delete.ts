import type { WithCacheConfig } from '~/cache/core/types.ts';
import { entityKind } from '~/entity.ts';
import type { HanaDialect } from '~/hana-core/dialect.ts';
import type {
	HanaPreparedQuery,
	HanaQueryResultHKT,
	HanaQueryResultKind,
	HanaSession,
	PreparedQueryConfig,
} from '~/hana-core/session.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import type { TypedQueryBuilder } from '~/query-builders/query-builder.ts';
import { QueryPromise } from '~/query-promise.ts';
import type { RunnableQuery } from '~/runnable-query.ts';
import { SelectionProxyHandler } from '~/selection-proxy.ts';
import type { ColumnsSelection, Query, SQL, SQLWrapper } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import { getTableName } from '~/table.ts';
import { tracer } from '~/tracing.ts';
import { extractUsedTable } from '../utils.ts';
import type { SelectedFieldsFlat } from './select.types.ts';

export type HanaDeleteWithout<
	T extends AnyHanaDeleteBase,
	TDynamic extends boolean,
	K extends keyof T & string,
> = TDynamic extends true ? T
	: Omit<
		HanaDeleteBase<
			T['_']['table'],
			T['_']['queryResult'],
			T['_']['selectedFields'],
			TDynamic,
			T['_']['excludedMethods'] | K
		>,
		T['_']['excludedMethods'] | K
	>;

export type HanaDelete<
	TTable extends HanaTable = HanaTable,
	TQueryResult extends HanaQueryResultHKT = HanaQueryResultHKT,
	TSelectedFields extends ColumnsSelection | undefined = undefined,
> = HanaDeleteBase<TTable, TQueryResult, TSelectedFields, true, never>;

export interface HanaDeleteConfig {
	where?: SQL | undefined;
	table: HanaTable;
	returningFields?: SelectedFieldsFlat;
	withList?: Subquery[];
}

export type HanaDeletePrepare<T extends AnyHanaDeleteBase> = HanaPreparedQuery<
	PreparedQueryConfig & {
		execute: HanaQueryResultKind<T['_']['queryResult'], never>;
	}
>;

export type HanaDeleteDynamic<T extends AnyHanaDeleteBase> = HanaDelete<
	T['_']['table'],
	T['_']['queryResult'],
	T['_']['selectedFields']
>;

export type AnyHanaDeleteBase = HanaDeleteBase<any, any, any, any, any>;

export interface HanaDeleteBase<
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

export class HanaDeleteBase<
	TTable extends HanaTable,
	TQueryResult extends HanaQueryResultHKT,
	TSelectedFields extends ColumnsSelection | undefined = undefined,
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
	static override readonly [entityKind]: string = 'HanaDelete';

	private config: HanaDeleteConfig;
	protected cacheConfig?: WithCacheConfig;

	constructor(
		table: TTable,
		private session: HanaSession,
		private dialect: HanaDialect,
		withList?: Subquery[],
	) {
		super();
		this.config = { table, withList };
	}

	/**
	 * Adds a `where` clause to the query.
	 *
	 * Calling this method will delete only those rows that fulfill a specified condition.
	 *
	 * See docs: {@link https://orm.drizzle.team/docs/delete}
	 *
	 * @param where the `where` clause.
	 *
	 * @example
	 * You can use conditional operators and `sql function` to filter the rows to be deleted.
	 *
	 * ```ts
	 * // Delete all cars with green color
	 * await db.delete(cars).where(eq(cars.color, 'green'));
	 * // or
	 * await db.delete(cars).where(sql`${cars.color} = 'green'`)
	 * ```
	 *
	 * You can logically combine conditional operators with `and()` and `or()` operators:
	 *
	 * ```ts
	 * // Delete all BMW cars with a green color
	 * await db.delete(cars).where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
	 *
	 * // Delete all cars with the green or blue color
	 * await db.delete(cars).where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
	 * ```
	 */
	where(where: SQL | undefined): HanaDeleteWithout<this, TDynamic, 'where'> {
		this.config.where = where;
		return this as any;
	}

	/** @internal */
	getSQL(): SQL {
		return this.dialect.buildDeleteQuery(this.config);
	}

	toSQL(): Query {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}

	/** @internal */
	_prepare(): HanaDeletePrepare<this> {
		return tracer.startActiveSpan('drizzle.prepareQuery', () => {
			return this.session.prepareQuery<
				PreparedQueryConfig & {
					execute: HanaQueryResultKind<TQueryResult, never>;
				}
			>(this.dialect.sqlToQuery(this.getSQL()), undefined, true, undefined, {
				type: 'delete',
				tables: extractUsedTable(this.config.table),
			}, this.cacheConfig);
		});
	}

	prepare(): HanaDeletePrepare<this> {
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

	$dynamic(): HanaDeleteDynamic<this> {
		return this as any;
	}
}
