import type { BuildColumns, BuildExtraConfigColumns, ColumnBuilderBase } from '~/column-builder.ts';
import { entityKind } from '~/entity.ts';
import {
	type InferTableColumnsModels,
	Table,
	type TableConfig as TableConfigBase,
	type UpdateTableConfig,
} from '~/table.ts';
import type { CheckBuilder } from './checks.ts';
import { getHanaColumnBuilders, type HanaColumnsBuilders } from './columns/all.ts';
import type { ExtraConfigColumn, HanaColumn, HanaColumnBuilder, HanaColumns } from './columns/common.ts';
import type { ForeignKey, ForeignKeyBuilder } from './foreign-keys.ts';
import type { AnyIndexBuilder } from './indexes.ts';
import type { PrimaryKeyBuilder } from './primary-keys.ts';
import type { UniqueConstraintBuilder } from './unique-constraint.ts';

export type HanaTableExtraConfigValue =
	| AnyIndexBuilder
	| CheckBuilder
	| ForeignKeyBuilder
	| PrimaryKeyBuilder
	| UniqueConstraintBuilder;

export type HanaTableExtraConfig = Record<
	string,
	HanaTableExtraConfigValue
>;

export type TableConfig = TableConfigBase<HanaColumns>;

/** @internal */
export const InlineForeignKeys = Symbol.for('drizzle:HanaInlineForeignKeys');

export class HanaTable<T extends TableConfig = TableConfig> extends Table<T> {
	static override readonly [entityKind]: string = 'HanaTable';

	/** @internal */
	static override readonly Symbol = Object.assign({}, Table.Symbol, {
		InlineForeignKeys: InlineForeignKeys as typeof InlineForeignKeys,
	});

	/**@internal */
	[InlineForeignKeys]: ForeignKey[] = [];

	/** @internal */
	override [Table.Symbol.ExtraConfigBuilder]: ((self: Record<string, HanaColumn>) => HanaTableExtraConfig) | undefined =
		undefined;

	/** @internal */
	override [Table.Symbol.ExtraConfigColumns]: Record<string, ExtraConfigColumn> = {};
}

export type AnyHanaTable<TPartial extends Partial<TableConfig> = {}> = HanaTable<
	UpdateTableConfig<TableConfig, TPartial>
>;

export type HanaTableWithColumns<
	T extends TableConfig,
> =
	& HanaTable<T>
	& T['columns']
	& InferTableColumnsModels<T['columns']>;

/** @internal */
export function hanaTableWithSchema<
	TTableName extends string,
	TSchemaName extends string | undefined,
	TColumnsMap extends Record<string, ColumnBuilderBase>,
>(
	name: TTableName,
	columns: TColumnsMap | ((columnTypes: HanaColumnsBuilders) => TColumnsMap),
	extraConfig:
		| ((
			self: BuildExtraConfigColumns<TTableName, TColumnsMap, 'hana'>,
		) => HanaTableExtraConfig | HanaTableExtraConfigValue[])
		| undefined,
	schema: TSchemaName,
	baseName = name,
): HanaTableWithColumns<{
	name: TTableName;
	schema: TSchemaName;
	columns: BuildColumns<TTableName, TColumnsMap, 'hana'>;
	dialect: 'hana';
}> {
	const rawTable = new HanaTable<{
		name: TTableName;
		schema: TSchemaName;
		columns: BuildColumns<TTableName, TColumnsMap, 'hana'>;
		dialect: 'hana';
	}>(name, schema, baseName);

	const parsedColumns: TColumnsMap = typeof columns === 'function' ? columns(getHanaColumnBuilders()) : columns;

	const builtColumns = Object.fromEntries(
		Object.entries(parsedColumns).map(([name, colBuilderBase]) => {
			const colBuilder = colBuilderBase as HanaColumnBuilder;
			colBuilder.setName(name);
			const column = colBuilder.build(rawTable);
			rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
			return [name, column];
		}),
	) as unknown as BuildColumns<TTableName, TColumnsMap, 'hana'>;

	const builtColumnsForExtraConfig = Object.fromEntries(
		Object.entries(parsedColumns).map(([name, colBuilderBase]) => {
			const colBuilder = colBuilderBase as HanaColumnBuilder;
			colBuilder.setName(name);
			const column = colBuilder.buildExtraConfigColumn(rawTable);
			return [name, column];
		}),
	) as unknown as BuildExtraConfigColumns<TTableName, TColumnsMap, 'hana'>;

	const table = Object.assign(rawTable, builtColumns);

	table[Table.Symbol.Columns] = builtColumns;
	table[Table.Symbol.ExtraConfigColumns] = builtColumnsForExtraConfig;

	if (extraConfig) {
		table[HanaTable.Symbol.ExtraConfigBuilder] = extraConfig as any;
	}

	return Object.assign(table, {}) as any;
}

export interface HanaTableFnInternal<TSchema extends string | undefined = undefined> {
	<
		TTableName extends string,
		TColumnsMap extends Record<string, ColumnBuilderBase>,
	>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig?: (
			self: BuildExtraConfigColumns<TTableName, TColumnsMap, 'hana'>,
		) => HanaTableExtraConfigValue[],
	): HanaTableWithColumns<{
		name: TTableName;
		schema: TSchema;
		columns: BuildColumns<TTableName, TColumnsMap, 'hana'>;
		dialect: 'hana';
	}>;

	<
		TTableName extends string,
		TColumnsMap extends Record<string, ColumnBuilderBase>,
	>(
		name: TTableName,
		columns: (columnTypes: HanaColumnsBuilders) => TColumnsMap,
		extraConfig?: (self: BuildExtraConfigColumns<TTableName, TColumnsMap, 'hana'>) => HanaTableExtraConfigValue[],
	): HanaTableWithColumns<{
		name: TTableName;
		schema: TSchema;
		columns: BuildColumns<TTableName, TColumnsMap, 'hana'>;
		dialect: 'hana';
	}>;
}

export interface HanaTableFn<TSchema extends string | undefined = undefined> extends HanaTableFnInternal<TSchema> {
}

const hanaTableInternal: HanaTableFnInternal = (name, columns, extraConfig) => {
	return hanaTableWithSchema(name, columns, extraConfig, undefined);
};

export const hanaTable: HanaTableFn = Object.assign(hanaTableInternal, {});

export function hanaTableCreator(customizeTableName: (name: string) => string): HanaTableFn {
	const fn: HanaTableFnInternal = (name, columns, extraConfig) => {
		return hanaTableWithSchema(customizeTableName(name) as typeof name, columns, extraConfig, undefined, name);
	};

	return Object.assign(fn, {});
}
