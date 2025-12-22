import type { WithCacheConfig } from '~/cache/core/types.ts';
import type { GetColumnData } from '~/column.ts';
import { entityKind, is } from '~/entity.ts';
import type { HanaDialect } from '~/hana-core/dialect.ts';
import type {
	HanaPreparedQuery,
	HanaQueryResultHKT,
	HanaQueryResultKind,
	HanaSession,
	PreparedQueryConfig,
} from '~/hana-core/session.ts';
import { HanaTable } from '~/hana-core/table.ts';
import type { TypedQueryBuilder } from '~/query-builders/query-builder.ts';
import type {
	AppendToNullabilityMap,
	GetSelectTableName,
	JoinNullability,
	JoinType,
} from '~/query-builders/select.types.ts';
import { QueryPromise } from '~/query-promise.ts';
import type { RunnableQuery } from '~/runnable-query.ts';
import { SelectionProxyHandler } from '~/selection-proxy.ts';
import { type ColumnsSelection, type Query, SQL, type SQLWrapper } from '~/sql/sql.ts';
import { Subquery } from '~/subquery.ts';
import { type InferInsertModel, Table } from '~/table.ts';
import { type DrizzleTypeError, getTableLikeName, mapUpdateSet, type UpdateSet } from '~/utils.ts';
import { ViewBaseConfig } from '~/view-common.ts';
import type { HanaColumn } from '../columns/common.ts';
import { extractUsedTable } from '../utils.ts';
import type { HanaViewBase } from '../view-base.ts';
import type { HanaSelectJoinConfig, TableLikeHasEmptySelection } from './select.types.ts';

export interface HanaUpdateConfig {
	where?: SQL | undefined;
	set: UpdateSet;
	table: HanaTable;
	from?: HanaTable | Subquery | HanaViewBase | SQL;
	joins: HanaSelectJoinConfig[];
	withList?: Subquery[];
}

export type HanaUpdateSetSource<
	TTable extends HanaTable,
	TModel extends Record<string, any> = InferInsertModel<TTable>,
> =
	& {
		[Key in keyof TModel & string]?:
			| GetColumnData<TTable['_']['columns'][Key]>
			| SQL
			| HanaColumn
			| undefined;
	}
	& {};

export class HanaUpdateBuilder<TTable extends HanaTable, TQueryResult extends HanaQueryResultHKT> {
	static readonly [entityKind]: string = 'HanaUpdateBuilder';

	declare readonly _: {
		readonly table: TTable;
	};

	constructor(
		private table: TTable,
		private session: HanaSession,
		private dialect: HanaDialect,
		private withList?: Subquery[],
	) {}

	set(
		values: HanaUpdateSetSource<TTable>,
	): HanaUpdateWithout<
		HanaUpdateBase<TTable, TQueryResult>,
		false,
		'leftJoin' | 'rightJoin' | 'innerJoin' | 'fullJoin'
	> {
		return new HanaUpdateBase<TTable, TQueryResult>(
			this.table,
			mapUpdateSet(this.table, values),
			this.session,
			this.dialect,
			this.withList,
		);
	}
}

export type HanaUpdateWithout<
	T extends AnyHanaUpdate,
	TDynamic extends boolean,
	K extends keyof T & string,
> = TDynamic extends true ? T : Omit<
	HanaUpdateBase<
		T['_']['table'],
		T['_']['queryResult'],
		T['_']['from'],
		T['_']['selectedFields'],
		T['_']['nullabilityMap'],
		T['_']['joins'],
		TDynamic,
		T['_']['excludedMethods'] | K
	>,
	T['_']['excludedMethods'] | K
>;

export type HanaUpdateWithJoins<
	T extends AnyHanaUpdate,
	TDynamic extends boolean,
	TFrom extends HanaTable | Subquery | HanaViewBase | SQL,
> = TDynamic extends true ? T : Omit<
	HanaUpdateBase<
		T['_']['table'],
		T['_']['queryResult'],
		TFrom,
		T['_']['selectedFields'],
		AppendToNullabilityMap<T['_']['nullabilityMap'], GetSelectTableName<TFrom>, 'inner'>,
		[...T['_']['joins'], {
			name: GetSelectTableName<TFrom>;
			joinType: 'inner';
			table: TFrom;
		}],
		TDynamic,
		Exclude<T['_']['excludedMethods'] | 'from', 'leftJoin' | 'rightJoin' | 'innerJoin' | 'fullJoin'>
	>,
	Exclude<T['_']['excludedMethods'] | 'from', 'leftJoin' | 'rightJoin' | 'innerJoin' | 'fullJoin'>
>;

export type HanaUpdateJoinFn<
	T extends AnyHanaUpdate,
	TDynamic extends boolean,
	TJoinType extends JoinType,
> = <
	TJoinedTable extends HanaTable | Subquery | HanaViewBase | SQL,
>(
	table: TableLikeHasEmptySelection<TJoinedTable> extends true ? DrizzleTypeError<
			"Cannot reference a data-modifying statement subquery if it doesn't contain a `returning` clause"
		>
		: TJoinedTable,
	on:
		| (
			(
				updateTable: T['_']['table']['_']['columns'],
				from: T['_']['from'] extends HanaTable ? T['_']['from']['_']['columns']
					: T['_']['from'] extends Subquery | HanaViewBase ? T['_']['from']['_']['selectedFields']
					: never,
			) => SQL | undefined
		)
		| SQL
		| undefined,
) => HanaUpdateJoin<T, TDynamic, TJoinType, TJoinedTable>;

export type HanaUpdateJoin<
	T extends AnyHanaUpdate,
	TDynamic extends boolean,
	TJoinType extends JoinType,
	TJoinedTable extends HanaTable | Subquery | HanaViewBase | SQL,
> = TDynamic extends true ? T : HanaUpdateBase<
	T['_']['table'],
	T['_']['queryResult'],
	T['_']['from'],
	T['_']['selectedFields'],
	AppendToNullabilityMap<T['_']['nullabilityMap'], GetSelectTableName<TJoinedTable>, TJoinType>,
	[...T['_']['joins'], {
		name: GetSelectTableName<TJoinedTable>;
		joinType: TJoinType;
		table: TJoinedTable;
	}],
	TDynamic,
	T['_']['excludedMethods']
>;

type Join = {
	name: string | undefined;
	joinType: JoinType;
	table: HanaTable | Subquery | HanaViewBase | SQL;
};

export type HanaUpdatePrepare<T extends AnyHanaUpdate> = HanaPreparedQuery<
	PreparedQueryConfig & {
		execute: HanaQueryResultKind<T['_']['queryResult'], never>;
	}
>;

export type HanaUpdateDynamic<T extends AnyHanaUpdate> = HanaUpdate<
	T['_']['table'],
	T['_']['queryResult'],
	T['_']['from'],
	T['_']['nullabilityMap']
>;

export type HanaUpdate<
	TTable extends HanaTable = HanaTable,
	TQueryResult extends HanaQueryResultHKT = HanaQueryResultHKT,
	TFrom extends HanaTable | Subquery | HanaViewBase | SQL | undefined = undefined,
	TSelectedFields extends ColumnsSelection | undefined = undefined,
	TNullabilityMap extends Record<string, JoinNullability> = Record<TTable['_']['name'], 'not-null'>,
	TJoins extends Join[] = [],
> = HanaUpdateBase<TTable, TQueryResult, TFrom, TSelectedFields, TNullabilityMap, TJoins, true, never>;

export type AnyHanaUpdate = HanaUpdateBase<any, any, any, any, any, any, any, any>;

export interface HanaUpdateBase<
	TTable extends HanaTable,
	TQueryResult extends HanaQueryResultHKT,
	TFrom extends HanaTable | Subquery | HanaViewBase | SQL | undefined = undefined,
	TSelectedFields extends ColumnsSelection | undefined = undefined,
	TNullabilityMap extends Record<string, JoinNullability> = Record<TTable['_']['name'], 'not-null'>,
	TJoins extends Join[] = [],
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
		readonly joins: TJoins;
		readonly nullabilityMap: TNullabilityMap;
		readonly queryResult: TQueryResult;
		readonly from: TFrom;
		readonly selectedFields: TSelectedFields;
		readonly dynamic: TDynamic;
		readonly excludedMethods: TExcludedMethods;
		readonly result: HanaQueryResultKind<TQueryResult, never>;
	};
}

export class HanaUpdateBase<
	TTable extends HanaTable,
	TQueryResult extends HanaQueryResultHKT,
	TFrom extends HanaTable | Subquery | HanaViewBase | SQL | undefined = undefined,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TSelectedFields extends ColumnsSelection | undefined = undefined,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TNullabilityMap extends Record<string, JoinNullability> = Record<TTable['_']['name'], 'not-null'>,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TJoins extends Join[] = [],
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TDynamic extends boolean = false,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	TExcludedMethods extends string = never,
> extends QueryPromise<HanaQueryResultKind<TQueryResult, never>>
	implements RunnableQuery<HanaQueryResultKind<TQueryResult, never>, 'hana'>, SQLWrapper
{
	static override readonly [entityKind]: string = 'HanaUpdate';

	private config: HanaUpdateConfig;
	private tableName: string | undefined;
	private joinsNotNullableMap: Record<string, boolean>;
	protected cacheConfig?: WithCacheConfig;

	constructor(
		table: TTable,
		set: UpdateSet,
		private session: HanaSession,
		private dialect: HanaDialect,
		withList?: Subquery[],
	) {
		super();
		this.config = { set, table, withList, joins: [] };
		this.tableName = getTableLikeName(table);
		this.joinsNotNullableMap = typeof this.tableName === 'string' ? { [this.tableName]: true } : {};
	}

	from<TFrom extends HanaTable | Subquery | HanaViewBase | SQL>(
		source: TableLikeHasEmptySelection<TFrom> extends true ? DrizzleTypeError<
				"Cannot reference a data-modifying statement subquery if it doesn't contain a `returning` clause"
			>
			: TFrom,
	): HanaUpdateWithJoins<this, TDynamic, TFrom> {
		const src = source as TFrom;
		const tableName = getTableLikeName(src);
		if (typeof tableName === 'string') {
			this.joinsNotNullableMap[tableName] = true;
		}
		this.config.from = src;
		return this as any;
	}

	private getTableLikeFields(table: HanaTable | Subquery | HanaViewBase): Record<string, unknown> {
		if (is(table, HanaTable)) {
			return table[Table.Symbol.Columns];
		} else if (is(table, Subquery)) {
			return table._.selectedFields;
		}
		return table[ViewBaseConfig].selectedFields;
	}

	private createJoin<TJoinType extends JoinType>(
		joinType: TJoinType,
	): HanaUpdateJoinFn<this, TDynamic, TJoinType> {
		return ((
			table: HanaTable | Subquery | HanaViewBase | SQL,
			on: ((updateTable: TTable, from: TFrom) => SQL | undefined) | SQL | undefined,
		) => {
			const tableName = getTableLikeName(table);

			if (typeof tableName === 'string' && this.config.joins.some((join) => join.alias === tableName)) {
				throw new Error(`Alias "${tableName}" is already used in this query`);
			}

			if (typeof on === 'function') {
				const from = this.config.from && !is(this.config.from, SQL)
					? this.getTableLikeFields(this.config.from)
					: undefined;
				on = on(
					new Proxy(
						this.config.table[Table.Symbol.Columns],
						new SelectionProxyHandler({ sqlAliasedBehavior: 'sql', sqlBehavior: 'sql' }),
					) as any,
					from && new Proxy(
						from,
						new SelectionProxyHandler({ sqlAliasedBehavior: 'sql', sqlBehavior: 'sql' }),
					) as any,
				);
			}

			this.config.joins.push({ on, table, joinType, alias: tableName });

			if (typeof tableName === 'string') {
				switch (joinType) {
					case 'left': {
						this.joinsNotNullableMap[tableName] = false;
						break;
					}
					case 'right': {
						this.joinsNotNullableMap = Object.fromEntries(
							Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false]),
						);
						this.joinsNotNullableMap[tableName] = true;
						break;
					}
					case 'inner': {
						this.joinsNotNullableMap[tableName] = true;
						break;
					}
					case 'full': {
						this.joinsNotNullableMap = Object.fromEntries(
							Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false]),
						);
						this.joinsNotNullableMap[tableName] = false;
						break;
					}
				}
			}

			return this as any;
		}) as any;
	}

	leftJoin = this.createJoin('left');

	rightJoin = this.createJoin('right');

	innerJoin = this.createJoin('inner');

	fullJoin = this.createJoin('full');

	/**
	 * Adds a 'where' clause to the query.
	 *
	 * Calling this method will update only those rows that fulfill a specified condition.
	 *
	 * See docs: {@link https://orm.drizzle.team/docs/update}
	 *
	 * @param where the 'where' clause.
	 *
	 * @example
	 * You can use conditional operators and `sql function` to filter the rows to be updated.
	 *
	 * ```ts
	 * // Update all cars with green color
	 * await db.update(cars).set({ color: 'red' })
	 *   .where(eq(cars.color, 'green'));
	 * // or
	 * await db.update(cars).set({ color: 'red' })
	 *   .where(sql`${cars.color} = 'green'`)
	 * ```
	 *
	 * You can logically combine conditional operators with `and()` and `or()` operators:
	 *
	 * ```ts
	 * // Update all BMW cars with a green color
	 * await db.update(cars).set({ color: 'red' })
	 *   .where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
	 *
	 * // Update all cars with the green or blue color
	 * await db.update(cars).set({ color: 'red' })
	 *   .where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
	 * ```
	 */
	where(where: SQL | undefined): HanaUpdateWithout<this, TDynamic, 'where'> {
		this.config.where = where;
		return this as any;
	}

	/** @internal */
	getSQL(): SQL {
		return this.dialect.buildUpdateQuery(this.config);
	}

	toSQL(): Query {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}

	/** @internal */
	_prepare(): HanaUpdatePrepare<this> {
		const query = this.session.prepareQuery<
			PreparedQueryConfig
		>(this.dialect.sqlToQuery(this.getSQL()), undefined, true, undefined, {
			type: 'insert',
			tables: extractUsedTable(this.config.table),
		}, this.cacheConfig);
		query.joinsNotNullableMap = this.joinsNotNullableMap;
		return query;
	}

	prepare(): HanaUpdatePrepare<this> {
		return this._prepare();
	}

	override execute: ReturnType<this['prepare']>['execute'] = (placeholderValues) => {
		return this._prepare().execute(placeholderValues);
	};

	$dynamic(): HanaUpdateDynamic<this> {
		return this as any;
	}
}
