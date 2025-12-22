import { aliasedTable, getOriginalColumnFromAlias } from '~/alias.ts';
import { CasingCache } from '~/casing.ts';
import { Column } from '~/column.ts';
import { entityKind, is } from '~/entity.ts';
import { DrizzleError } from '~/errors.ts';
import { HanaArray, HanaColumn, type HanaCustomColumn } from '~/hana-core/columns/index.ts';
import type {
	AnyHanaSelectQueryBuilder,
	HanaDeleteConfig,
	HanaInsertConfig,
	HanaSelectJoinConfig,
	HanaUpdateConfig,
} from '~/hana-core/query-builders/index.ts';
import type { HanaSelectConfig, SelectedFieldsOrdered } from '~/hana-core/query-builders/select.types.ts';
import { HanaTable } from '~/hana-core/table.ts';
import type { MigrationConfig, MigrationMeta, MigratorInitFailResponse } from '~/migrator.ts';
import {
	type AnyOne,
	// AggregatedField,
	type BuildRelationalQueryResult,
	type DBQueryConfig,
	getTableAsAliasSQL,
	One,
	type Relation,
	relationExtrasToSQL,
	relationsFilterToSQL,
	relationsOrderToSQL,
	relationToSQL,
	type TableRelationalConfig,
	type TablesRelationalConfig,
	type WithContainer,
} from '~/relations.ts';
import { and, isSQLWrapper, type SQLWrapper, View } from '~/sql/index.ts';
import { type Name, Param, type QueryWithTypings, SQL, sql, type SQLChunk } from '~/sql/sql.ts';
import { Subquery } from '~/subquery.ts';
import { getTableName, Table, TableColumns } from '~/table.ts';
import { type Casing, orderSelectedFields, type UpdateSet } from '~/utils.ts';
import { ViewBaseConfig } from '~/view-common.ts';
import type { HanaSession } from './session.ts';
import { HanaViewBase } from './view-base.ts';
import type { HanaMaterializedView, HanaView } from './view.ts';

export interface HanaDialectConfig {
	casing?: Casing;
}

export class HanaDialect {
	static readonly [entityKind]: string = 'HanaDialect';

	/** @internal */
	readonly casing: CasingCache;

	constructor(config?: HanaDialectConfig) {
		this.casing = new CasingCache(config?.casing);
	}

	async migrate(
		_migrations: MigrationMeta[],
		_session: HanaSession,
		_config: string | MigrationConfig,
	): Promise<void | MigratorInitFailResponse> {
		// TODO: handle migrations
	}

	escapeName(name: string): string {
		return `"${name}"`;
	}

	escapeParam(num: number): string {
		return `$${num + 1}`;
	}

	escapeString(str: string): string {
		return `'${str.replace(/'/g, "''")}'`;
	}

	private buildWithCTE(queries: Subquery[] | undefined): SQL | undefined {
		if (!queries?.length) return undefined;

		const withSqlChunks = [sql`with `];
		for (const [i, w] of queries.entries()) {
			withSqlChunks.push(
				sql`${sql.identifier(w._.alias)} as (${w._.sql})`,
			);
			if (i < queries.length - 1) {
				withSqlChunks.push(sql`, `);
			}
		}
		withSqlChunks.push(sql` `);
		return sql.join(withSqlChunks);
	}

	buildDeleteQuery({ table, where, withList }: HanaDeleteConfig): SQL {
		const withSql = this.buildWithCTE(withList);

		const whereSql = where ? sql` where ${where}` : undefined;

		return sql`${withSql}delete from ${table}${whereSql}`;
	}

	buildUpdateSet(table: HanaTable, set: UpdateSet): SQL {
		const tableColumns = table[Table.Symbol.Columns];

		const columnNames = Object.keys(tableColumns).filter(
			(colName) =>
				set[colName] !== undefined
				|| tableColumns[colName]?.onUpdateFn !== undefined,
		);

		const setLength = columnNames.length;
		return sql.join(
			columnNames.flatMap((colName, i) => {
				const col = tableColumns[colName]!;

				const onUpdateFnResult = col.onUpdateFn?.();
				const value = set[colName]
					?? (is(onUpdateFnResult, SQL)
						? onUpdateFnResult
						: sql.param(onUpdateFnResult, col));
				const res = sql`${
					sql.identifier(
						this.casing.getColumnCasing(col),
					)
				} = ${value}`;

				if (i < setLength - 1) {
					return [res, sql.raw(', ')];
				}
				return [res];
			}),
		);
	}

	buildUpdateQuery({
		table,
		set,
		where,
		withList,
		from,
		joins,
	}: HanaUpdateConfig): SQL {
		const withSql = this.buildWithCTE(withList);

		const tableName = table[HanaTable.Symbol.Name];
		const tableSchema = table[HanaTable.Symbol.Schema];
		const origTableName = table[HanaTable.Symbol.OriginalName];
		const alias = tableName === origTableName ? undefined : tableName;
		const tableSql = sql`${tableSchema ? sql`${sql.identifier(tableSchema)}.` : undefined}${
			sql.identifier(origTableName)
		}${alias && sql` ${sql.identifier(alias)}`}`;

		const setSql = this.buildUpdateSet(table, set);

		const fromSql = from && sql.join([sql.raw(' from '), this.buildFromTable(from)]);

		const joinsSql = this.buildJoins(joins);

		// TODO: handle returning count

		const whereSql = where ? sql` where ${where}` : undefined;

		return sql`${withSql}update ${tableSql} set ${setSql}${fromSql}${joinsSql}${whereSql}`;
	}

	/**
	 * Builds selection SQL with provided fields/expressions
	 *
	 * Examples:
	 *
	 * `select <selection> from`
	 *
	 * `insert ... returning <selection>`
	 *
	 * If `isSingleTable` is true, then columns won't be prefixed with table name
	 */
	private buildSelection(
		fields: SelectedFieldsOrdered,
	): SQL {
		const columnsLen = fields.length;

		const chunks = fields.flatMap(({ field }, i) => {
			const chunk: SQLChunk[] = [];

			if (is(field, SQL.Aliased) && field.isSelectionField) {
				chunk.push(sql.identifier(field.fieldAlias));
			} else if (is(field, SQL.Aliased) || is(field, SQL)) {
				const query = is(field, SQL.Aliased) ? field.sql : field;

				chunk.push(query);

				if (is(field, SQL.Aliased)) {
					chunk.push(sql` as ${sql.identifier(field.fieldAlias)}`);
				}
			} else if (is(field, Column)) {
				chunk.push(
					field.isAlias
						? sql`${
							getOriginalColumnFromAlias(
								field,
							)
						} as ${field}`
						: field,
				);
			} else if (is(field, Subquery)) {
				const entries = Object.entries(field._.selectedFields) as [
					string,
					SQL.Aliased | Column | SQL,
				][];

				if (entries.length === 1) {
					const entry = entries[0]![1];

					const fieldDecoder = is(entry, SQL)
						? entry.decoder
						: is(entry, Column)
						? {
							mapFromDriverValue: (v: any) => entry.mapFromDriverValue(v),
						}
						: entry.sql.decoder;

					if (fieldDecoder) {
						field._.sql.decoder = fieldDecoder;
					}
				}
				chunk.push(field);
			}

			if (i < columnsLen - 1) {
				chunk.push(sql`, `);
			}

			return chunk;
		});

		return sql.join(chunks);
	}

	private buildJoins(
		joins: HanaSelectJoinConfig[] | undefined,
	): SQL | undefined {
		if (!joins || joins.length === 0) {
			return undefined;
		}

		const joinsArray: SQL[] = [];

		for (const [index, joinMeta] of joins.entries()) {
			if (index === 0) {
				joinsArray.push(sql` `);
			}
			const table = joinMeta.table;
			const lateralSql = joinMeta.lateral ? sql` lateral` : undefined;
			const onSql = joinMeta.on ? sql` on ${joinMeta.on}` : undefined;

			if (is(table, HanaTable)) {
				const tableName = table[HanaTable.Symbol.Name];
				const tableSchema = table[HanaTable.Symbol.Schema];
				const origTableName = table[HanaTable.Symbol.OriginalName];
				const alias = tableName === origTableName ? undefined : joinMeta.alias;
				joinsArray.push(
					sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${
						tableSchema
							? sql`${sql.identifier(tableSchema)}.`
							: undefined
					}${sql.identifier(origTableName)}${alias && sql` ${sql.identifier(alias)}`}${onSql}`,
				);
			} else if (is(table, View)) {
				const viewName = table[ViewBaseConfig].name;
				const viewSchema = table[ViewBaseConfig].schema;
				const origViewName = table[ViewBaseConfig].originalName;
				const alias = viewName === origViewName ? undefined : joinMeta.alias;
				joinsArray.push(
					sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${
						viewSchema
							? sql`${sql.identifier(viewSchema)}.`
							: undefined
					}${sql.identifier(origViewName)}${alias && sql` ${sql.identifier(alias)}`}${onSql}`,
				);
			} else {
				joinsArray.push(
					sql`${
						sql.raw(
							joinMeta.joinType,
						)
					} join${lateralSql} ${table}${onSql}`,
				);
			}
			if (index < joins.length - 1) {
				joinsArray.push(sql` `);
			}
		}

		return sql.join(joinsArray);
	}

	private buildFromTable(
		table: SQL | Subquery | HanaViewBase | HanaTable | undefined,
	): SQL | Subquery | HanaViewBase | HanaTable | undefined {
		if (is(table, Table) && table[Table.Symbol.IsAlias]) {
			let fullName = sql`${
				sql.identifier(
					table[Table.Symbol.OriginalName],
				)
			}`;
			if (table[Table.Symbol.Schema]) {
				fullName = sql`${
					sql.identifier(
						table[Table.Symbol.Schema]!,
					)
				}.${fullName}`;
			}
			return sql`${fullName} ${sql.identifier(table[Table.Symbol.Name])}`;
		}

		return table;
	}

	buildSelectQuery({
		withList,
		fields,
		fieldsFlat,
		where,
		having,
		table,
		joins,
		orderBy,
		groupBy,
		limit,
		offset,
		lockingClause,
		distinct,
		setOperators,
	}: HanaSelectConfig): SQL {
		const fieldsList = fieldsFlat ?? orderSelectedFields<HanaColumn>(fields);
		for (const f of fieldsList) {
			if (
				is(f.field, Column)
				&& getTableName(f.field.table)
					!== (is(table, Subquery)
						? table._.alias
						: is(table, HanaViewBase)
						? table[ViewBaseConfig].name
						: is(table, SQL)
						? undefined
						: getTableName(table))
				&& !((table) =>
					joins?.some(
						({ alias }) =>
							alias
								=== (table[Table.Symbol.IsAlias]
									? getTableName(table)
									: table[Table.Symbol.BaseName]),
					))(f.field.table)
			) {
				const tableName = getTableName(f.field.table);
				throw new Error(
					`Your "${
						f.path.join(
							'->',
						)
					}" field references a column "${tableName}"."${f.field.name}", but the table "${tableName}" is not part of the query! Did you forget to join it?`,
				);
			}
		}

		const withSql = this.buildWithCTE(withList);

		let distinctSql: SQL | undefined;
		if (distinct) {
			distinctSql = distinct === true
				? sql` distinct`
				: sql` distinct on (${sql.join(distinct.on, sql`, `)})`;
		}

		const selection = this.buildSelection(fieldsList);

		const tableSql = this.buildFromTable(table);

		const joinsSql = this.buildJoins(joins);

		const whereSql = where ? sql` where ${where}` : undefined;

		const havingSql = having ? sql` having ${having}` : undefined;

		let orderBySql;
		if (orderBy && orderBy.length > 0) {
			orderBySql = sql` order by ${sql.join(orderBy, sql`, `)}`;
		}

		let groupBySql;
		if (groupBy && groupBy.length > 0) {
			groupBySql = sql` group by ${sql.join(groupBy, sql`, `)}`;
		}

		const limitSql = typeof limit === 'object'
				|| (typeof limit === 'number' && limit >= 0)
			? sql` limit ${limit}`
			: undefined;

		const offsetSql = offset ? sql` offset ${offset}` : undefined;

		const lockingClauseSql = sql.empty();
		if (lockingClause) {
			const clauseSql = sql` for ${sql.raw(lockingClause.strength)}`;
			if (lockingClause.config.of) {
				clauseSql.append(
					sql` of ${
						sql.join(
							Array.isArray(lockingClause.config.of)
								? lockingClause.config.of
								: [lockingClause.config.of],
							sql`, `,
						)
					}`,
				);
			}
			if (lockingClause.config.noWait) {
				clauseSql.append(sql` nowait`);
			} else if (lockingClause.config.skipLocked) {
				clauseSql.append(sql` skip locked`);
			}
			lockingClauseSql.append(clauseSql);
		}
		const finalQuery =
			sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}${offsetSql}${lockingClauseSql}`;

		if (setOperators.length > 0) {
			return this.buildSetOperations(finalQuery, setOperators);
		}

		return finalQuery;
	}

	buildSetOperations(
		leftSelect: SQL,
		setOperators: HanaSelectConfig['setOperators'],
	): SQL {
		const [setOperator, ...rest] = setOperators;

		if (!setOperator) {
			throw new Error('Cannot pass undefined values to any set operator');
		}

		if (rest.length === 0) {
			return this.buildSetOperationQuery({ leftSelect, setOperator });
		}

		// Some recursive magic here
		return this.buildSetOperations(
			this.buildSetOperationQuery({ leftSelect, setOperator }),
			rest,
		);
	}

	buildSetOperationQuery({
		leftSelect,
		setOperator: { type, isAll, rightSelect, limit, orderBy, offset },
	}: {
		leftSelect: SQL;
		setOperator: HanaSelectConfig['setOperators'][number];
	}): SQL {
		const leftChunk = sql`(${leftSelect.getSQL()}) `;
		const rightChunk = sql`(${rightSelect.getSQL()})`;

		let orderBySql;
		if (orderBy && orderBy.length > 0) {
			const orderByValues: (SQL<unknown> | Name)[] = [];

			// The next bit is necessary because the sql operator replaces ${table.column} with `table`.`column`
			// which is invalid Sql syntax, Table from one of the SELECTs cannot be used in global ORDER clause
			for (const singleOrderBy of orderBy) {
				if (is(singleOrderBy, HanaColumn)) {
					orderByValues.push(sql.identifier(singleOrderBy.name));
				} else if (is(singleOrderBy, SQL)) {
					for (let i = 0; i < singleOrderBy.queryChunks.length; i++) {
						const chunk = singleOrderBy.queryChunks[i];

						if (is(chunk, HanaColumn)) {
							singleOrderBy.queryChunks[i] = sql.identifier(
								chunk.name,
							);
						}
					}

					orderByValues.push(sql`${singleOrderBy}`);
				} else {
					orderByValues.push(sql`${singleOrderBy}`);
				}
			}

			orderBySql = sql` order by ${sql.join(orderByValues, sql`, `)} `;
		}

		const limitSql = typeof limit === 'object'
				|| (typeof limit === 'number' && limit >= 0)
			? sql` limit ${limit}`
			: undefined;

		const operatorChunk = sql.raw(`${type} ${isAll ? 'all ' : ''}`);

		const offsetSql = offset ? sql` offset ${offset}` : undefined;

		return sql`${leftChunk}${operatorChunk}${rightChunk}${orderBySql}${limitSql}${offsetSql}`;
	}

	buildInsertQuery({
		table,
		values: valuesOrSelect,
		withList,
		select,
		overridingSystemValue_,
	}: HanaInsertConfig): SQL {
		const valuesSqlList: ((SQLChunk | SQL)[] | SQL)[] = [];
		const columns: Record<string, HanaColumn> = table[Table.Symbol.Columns];

		const colEntries: [string, HanaColumn][] = Object.entries(
			columns,
		).filter(([_, col]) => !col.shouldDisableInsert());

		const insertOrder = colEntries.map(([, column]) => sql.identifier(this.casing.getColumnCasing(column)));

		if (select) {
			const select = valuesOrSelect as AnyHanaSelectQueryBuilder | SQL;

			if (is(select, SQL)) {
				valuesSqlList.push(select);
			} else {
				valuesSqlList.push(select.getSQL());
			}
		} else {
			const values = valuesOrSelect as Record<string, Param | SQL>[];
			valuesSqlList.push(sql.raw('values '));

			for (const [valueIndex, value] of values.entries()) {
				const valueList: (SQLChunk | SQL)[] = [];
				for (const [fieldName, col] of colEntries) {
					const colValue = value[fieldName];
					if (
						colValue === undefined
						|| (is(colValue, Param) && colValue.value === undefined)
					) {
						// eslint-disable-next-line unicorn/no-negated-condition
						if (col.defaultFn !== undefined) {
							const defaultFnResult = col.defaultFn();
							const defaultValue = is(defaultFnResult, SQL)
								? defaultFnResult
								: sql.param(defaultFnResult, col);
							valueList.push(defaultValue);
							// eslint-disable-next-line unicorn/no-negated-condition
						} else if (
							!col.default
							&& col.onUpdateFn !== undefined
						) {
							const onUpdateFnResult = col.onUpdateFn();
							const newValue = is(onUpdateFnResult, SQL)
								? onUpdateFnResult
								: sql.param(onUpdateFnResult, col);
							valueList.push(newValue);
						} else {
							valueList.push(sql`default`);
						}
					} else {
						valueList.push(colValue);
					}
				}

				valuesSqlList.push(valueList);
				if (valueIndex < values.length - 1) {
					valuesSqlList.push(sql`, `);
				}
			}
		}

		const withSql = this.buildWithCTE(withList);

		const valuesSql = sql.join(valuesSqlList);

		const overridingSql = overridingSystemValue_ === true
			? sql`overriding system value `
			: undefined;

		return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}${valuesSql}`;
	}

	buildRefreshMaterializedViewQuery({
		view,
		concurrently,
		withNoData,
	}: {
		view: HanaMaterializedView;
		concurrently?: boolean;
		withNoData?: boolean;
	}): SQL {
		const concurrentlySql = concurrently ? sql` concurrently` : undefined;
		const withNoDataSql = withNoData ? sql` with no data` : undefined;

		return sql`refresh materialized view${concurrentlySql} ${view}${withNoDataSql}`;
	}

	sqlToQuery(
		sql: SQL,
		invokeSource?: 'indexes' | undefined,
	): QueryWithTypings {
		return sql.toQuery({
			casing: this.casing,
			escapeName: this.escapeName,
			escapeParam: this.escapeParam,
			escapeString: this.escapeString,
			invokeSource,
		});
	}

	private nestedSelectionError() {
		throw new DrizzleError({
			message: `Views with nested selections are not supported by the relational query builder`,
		});
	}

	private buildRqbColumn(table: Table | View, column: unknown, key: string) {
		if (is(column, Column)) {
			const name = sql`${table}.${
				sql.identifier(
					this.casing.getColumnCasing(column),
				)
			}`;
			let targetType = column.columnType;
			let col = column;
			while (is(col, HanaArray)) {
				col = col.baseColumn;
				targetType = col.columnType;
			}

			switch (targetType) {
				case 'HanaNumeric':
				case 'HanaNumericNumber':
				case 'HanaNumericBigInt':
				case 'HanaBigInt64':
				case 'HanaBigIntString':
				case 'HanaBigSerial64':
				case 'HanaTimestampString': {
					return sql`cast(${name} as char) as ${sql.identifier(key)}`;
				}
				case 'HanaCustomColumn': {
					return sql`${
						(<HanaCustomColumn<any>> col).jsonSelectIdentifier(
							name,
							sql,
						)
					} as ${sql.identifier(key)}`;
				}
				default: {
					return sql`${name} as ${sql.identifier(key)}`;
				}
			}
		}

		return sql`${table}.${
			is(column, SQL.Aliased)
				? sql.identifier(column.fieldAlias)
				: isSQLWrapper(column)
				? sql.identifier(key)
				: this.nestedSelectionError()
		} as ${sql.identifier(key)}`;
	}

	private unwrapAllColumns = (
		table: Table | View,
		selection: BuildRelationalQueryResult['selection'],
	) => {
		return sql.join(
			Object.entries(table[TableColumns]).map(([k, v]) => {
				selection.push({
					key: k,
					field: v as Column | SQL | SQLWrapper | SQL.Aliased,
				});

				return this.buildRqbColumn(table, v, k);
			}),
			sql`, `,
		);
	};

	private buildColumns = (
		table: Table | View,
		selection: BuildRelationalQueryResult['selection'],
		config?: DBQueryConfig<'many'>,
	) =>
		config?.columns
			? (() => {
				const entries = Object.entries(config.columns);
				const columnContainer: Record<string, unknown> = table[TableColumns];

				const columnIdentifiers: SQL[] = [];
				let colSelectionMode: boolean | undefined;
				for (const [k, v] of entries) {
					if (v === undefined) continue;
					colSelectionMode = colSelectionMode || v;

					if (v) {
						const column = columnContainer[k];
						columnIdentifiers.push(
							this.buildRqbColumn(table, column, k),
						);

						selection.push({
							key: k,
							field: column as
								| SQL
								| SQLWrapper
								| SQL.Aliased
								| Column,
						});
					}
				}

				if (colSelectionMode === false) {
					for (const [k, v] of Object.entries(columnContainer)) {
						if (config.columns[k] === false) continue;
						columnIdentifiers.push(
							this.buildRqbColumn(table, v, k),
						);

						selection.push({
							key: k,
							field: v as
								| SQL
								| SQLWrapper
								| SQL.Aliased
								| Column,
						});
					}
				}

				return columnIdentifiers.length
					? sql.join(columnIdentifiers, sql`, `)
					: undefined;
			})()
			: this.unwrapAllColumns(table, selection);

	buildRelationalQuery({
		schema,
		table,
		tableConfig,
		queryConfig: config,
		relationWhere,
		mode,
		errorPath,
		depth,
		throughJoin,
	}: {
		schema: TablesRelationalConfig;
		table: HanaTable | HanaView;
		tableConfig: TableRelationalConfig;
		queryConfig?: DBQueryConfig<'many'> | true;
		relationWhere?: SQL;
		mode: 'first' | 'many';
		errorPath?: string;
		depth?: number;
		throughJoin?: SQL;
	}): BuildRelationalQueryResult {
		const selection: BuildRelationalQueryResult['selection'] = [];
		const isSingle = mode === 'first';
		const params = config === true ? undefined : config;
		const currentPath = errorPath ?? '';
		const currentDepth = depth ?? 0;
		if (!currentDepth) table = aliasedTable(table, `d${currentDepth}`);

		const limit = isSingle ? 1 : params?.limit;
		const offset = params?.offset;

		const where: SQL | undefined = params?.where && relationWhere
			? and(
				relationsFilterToSQL(
					table,
					params.where,
					tableConfig.relations,
					schema,
					this.casing,
				),
				relationWhere,
			)
			: params?.where
			? relationsFilterToSQL(
				table,
				params.where,
				tableConfig.relations,
				schema,
				this.casing,
			)
			: relationWhere;

		const order = params?.orderBy
			? relationsOrderToSQL(table, params.orderBy)
			: undefined;
		const columns = this.buildColumns(table, selection, params);
		const extras = params?.extras
			? relationExtrasToSQL(table, params.extras)
			: undefined;
		if (extras) selection.push(...extras.selection);

		const selectionArr: SQL[] = columns ? [columns] : [];

		const subqueries = params
			? (() => {
				const { with: joins } = params as WithContainer;
				if (!joins) return;

				const withEntries = Object.entries(joins).filter(
					([_, v]) => v,
				);
				if (!withEntries.length) return;

				return sql.join(
					withEntries.map(([k, join]) => {
						const relation = tableConfig.relations[
							k
						]! as Relation;
						const isSingle = is(relation, One);
						const targetTable = aliasedTable(
							relation.targetTable,
							`d${currentDepth + 1}`,
						);
						const throughTable = relation.throughTable
							? (aliasedTable(
								relation.throughTable,
								`tr${currentDepth}`,
							) as Table | View)
							: undefined;

						const { filter, joinCondition } = relationToSQL(
							this.casing,
							relation,
							table,
							targetTable,
							throughTable,
						);

						const innerQuery = this.buildRelationalQuery({
							table: targetTable as HanaTable | HanaView,
							// HACK: hana doesn't support limit in subqueries
							mode: 'many',
							schema,
							queryConfig: join as DBQueryConfig,
							tableConfig: schema[relation.targetTableName]!,
							relationWhere: filter,
							errorPath: `${currentPath.length ? `${currentPath}.` : ''}${k}`,
							depth: currentDepth + 1,

							// TODO: handle through
							throughJoin: undefined,
						});

						selection.push({
							field: targetTable,
							key: k,
							selection: innerQuery.selection,
							isArray: !isSingle,
							isOptional: ((relation as AnyOne).optional ?? false)
								|| (join !== true
									&& !!(
										join as Exclude<
											typeof join,
											boolean | undefined
										>
									).where),
						});

						let subquery: SQL;

						if (throughTable && joinCondition) {
							subquery = sql`(select ${innerQuery.sql.queryChunks[0]} from ${
								getTableAsAliasSQL(
									throughTable,
								)
							} inner join ${
								getTableAsAliasSQL(
									targetTable,
								)
							} on ${joinCondition} where ${filter} for json ('omitnull'='no')) as ${
								sql.identifier(
									k,
								)
							}`;
						} else {
							subquery = sql`(${innerQuery.sql} for json ('omitnull'='no')) as ${
								sql.identifier(
									k,
								)
							}`;
						}

						return subquery;
					}),
					sql`, `,
				);
			})()
			: undefined;

		if (extras?.sql) selectionArr.push(extras.sql);

		// Add subqueries to the selection array instead of using lateral joins
		if (subqueries) {
			selectionArr.push(subqueries);
		}

		if (!selectionArr.length) {
			throw new DrizzleError({
				message: `No fields selected for table "${tableConfig.name}"${currentPath ? ` ("${currentPath}")` : ''}`,
			});
		}

		const selectionSet = sql.join(
			selectionArr.filter((e) => e !== undefined),
			sql`, `,
		);

		// Build the final query without lateral joins (HANA-style)
		const query = sql`select ${selectionSet} from ${
			getTableAsAliasSQL(
				table,
			)
		}${throughJoin ? sql` ${throughJoin}` : sql``}${sql` where ${where}`.if(where)}${
			sql` order by ${order}`.if(
				order,
			)
		}${
			sql` limit ${limit}`.if(
				limit !== undefined,
			)
		}${sql` offset ${offset}`.if(offset !== undefined)}`;

		return {
			sql: query,
			selection,
		};
	}
}
