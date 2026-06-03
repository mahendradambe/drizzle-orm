import type {
	ColumnBuilderBaseConfig,
	ColumnBuilderExtraConfig,
	ColumnBuilderRuntimeConfig,
	ColumnType,
	HasGenerated,
} from '~/column-builder.ts';
import { ColumnBuilder } from '~/column-builder.ts';
import type { ColumnBaseConfig } from '~/column.ts';
import { Column } from '~/column.ts';
import { entityKind, is } from '~/entity.ts';
import type { ForeignKey, UpdateDeleteAction } from '~/hana-core/foreign-keys.ts';
import { ForeignKeyBuilder } from '~/hana-core/foreign-keys.ts';
import type { AnyHanaTable, HanaTable } from '~/hana-core/table.ts';
import type { SQL } from '~/sql/sql.ts';
import { iife } from '~/tracing-utils.ts';
import type { Update } from '~/utils.ts';
import type { HanaIndexOpClass } from '../indexes.ts';
import { makeHanaArray, parseHanaArray } from '../utils/array.ts';

export type HanaColumns = Record<string, HanaColumn<any>>;

export interface ReferenceConfig {
	ref: () => HanaColumn;
	config: {
		name?: string;
		onUpdate?: UpdateDeleteAction;
		onDelete?: UpdateDeleteAction;
	};
}

export abstract class HanaColumnBuilder<
	T extends ColumnBuilderBaseConfig<ColumnType> = ColumnBuilderBaseConfig<ColumnType>,
	TRuntimeConfig extends object = object,
> extends ColumnBuilder<T, TRuntimeConfig, ColumnBuilderExtraConfig> {
	private foreignKeyConfigs: ReferenceConfig[] = [];

	static override readonly [entityKind]: string = 'HanaColumnBuilder';

	array(length?: number): HanaArrayBuilder<
		& {
			name: string;
			dataType: 'array basecolumn';
			data: T['data'][];
			driverParam: T['driverParam'][] | string;
			baseBuilder: T;
		}
		& (T extends { notNull: true } ? { notNull: true } : {})
		& (T extends { hasDefault: true } ? { hasDefault: true } : {}),
		T
	> {
		return new HanaArrayBuilder(this.config.name, this as HanaColumnBuilder<any, any>, length as any);
	}

	references(
		ref: ReferenceConfig['ref'],
		config: ReferenceConfig['config'] = {},
	): this {
		this.foreignKeyConfigs.push({ ref, config });
		return this;
	}

	unique(
		name?: string,
		config?: { nulls: 'distinct' | 'not distinct' },
	): this {
		this.config.isUnique = true;
		this.config.uniqueName = name;
		this.config.uniqueType = config?.nulls;
		return this;
	}

	generatedAlwaysAs(as: SQL | T['data'] | (() => SQL)): HasGenerated<this, {
		type: 'always';
	}> {
		this.config.generated = {
			as,
			type: 'always',
			mode: 'stored',
		};
		return this as HasGenerated<this, {
			type: 'always';
		}>;
	}

	/** @internal */
	buildForeignKeys(column: HanaColumn, table: HanaTable): ForeignKey[] {
		return this.foreignKeyConfigs.map(({ ref, config }) => {
			return iife(
				(ref, config) => {
					const builder = new ForeignKeyBuilder(() => {
						const foreignColumn = ref();
						return { name: config.name, columns: [column], foreignColumns: [foreignColumn] };
					});
					if (config.onUpdate) {
						builder.onUpdate(config.onUpdate);
					}
					if (config.onDelete) {
						builder.onDelete(config.onDelete);
					}
					return builder.build(table);
				},
				ref,
				config,
			);
		});
	}

	/** @internal */
	abstract build(table: HanaTable): HanaColumn<any>;

	/** @internal */
	buildExtraConfigColumn<TTableName extends string>(
		table: AnyHanaTable<{ name: TTableName }>,
	): ExtraConfigColumn {
		return new ExtraConfigColumn(table, this.config);
	}
}

// To understand how to use `HanaColumn` and `HanaColumn`, see `Column` and `AnyColumn` documentation.
export abstract class HanaColumn<
	T extends ColumnBaseConfig<ColumnType> = ColumnBaseConfig<ColumnType>,
	TRuntimeConfig extends object = {},
> extends Column<T, TRuntimeConfig> {
	static override readonly [entityKind]: string = 'HanaColumn';

	/** @internal */
	override readonly table: HanaTable;

	constructor(
		table: HanaTable,
		config: ColumnBuilderRuntimeConfig<T['data']> & TRuntimeConfig,
	) {
		super(table, config);
		this.table = table;
	}
}

export type IndexedExtraConfigType = { order?: 'asc' | 'desc'; nulls?: 'first' | 'last'; opClass?: string };

export class ExtraConfigColumn<
	T extends ColumnBaseConfig<ColumnType> = ColumnBaseConfig<ColumnType>,
> extends HanaColumn<T, IndexedExtraConfigType> {
	static override readonly [entityKind]: string = 'ExtraConfigColumn';

	override getSQLType(): string {
		return this.getSQLType();
	}

	indexConfig: IndexedExtraConfigType = {
		order: this.config.order ?? 'asc',
		nulls: this.config.nulls ?? 'last',
		opClass: this.config.opClass,
	};
	defaultConfig: IndexedExtraConfigType = {
		order: 'asc',
		nulls: 'last',
		opClass: undefined,
	};

	asc(): Omit<this, 'asc' | 'desc'> {
		this.indexConfig.order = 'asc';
		return this;
	}

	desc(): Omit<this, 'asc' | 'desc'> {
		this.indexConfig.order = 'desc';
		return this;
	}

	nullsFirst(): Omit<this, 'nullsFirst' | 'nullsLast'> {
		this.indexConfig.nulls = 'first';
		return this;
	}

	nullsLast(): Omit<this, 'nullsFirst' | 'nullsLast'> {
		this.indexConfig.nulls = 'last';
		return this;
	}

	/**
	 * Operator class selector for an index expression. The supplied class
	 * binds the column to a specific set of comparison / lookup operators
	 * when the index is evaluated.
	 *
	 * SAP HANA's standard B-tree / CPB-tree / inverted-value indexes use the
	 * column's native type ordering; an operator class is required only for
	 * specialized index families (text / spatial / vector).
	 *
	 * If the `hana_vector` extension is installed, the following
	 * operator-class tokens are recognised: `vector_l2_ops`, `vector_ip_ops`,
	 * `vector_cosine_ops`, `vector_l1_ops`, `bit_hamming_ops`,
	 * `bit_jaccard_ops`, `halfvec_l2_ops`, `sparsevec_l2_ops`.
	 *
	 * Any string value is accepted at the type-system layer via the widened
	 * `(string & {})` escape-hatch on `HanaIndexOpClass`; the driver passes
	 * the token through verbatim to HANA. Use this when the desired
	 * operator class is not enumerated in the dialect.
	 *
	 * @see SAP HANA SQL Reference Guide -- CREATE INDEX
	 * (CITATION-UNAVAILABLE: HANA Cloud `hana_vector` extension docs)
	 *
	 * @param opClass
	 * @returns
	 */
	op(opClass: HanaIndexOpClass): Omit<this, 'op'> {
		this.indexConfig.opClass = opClass;
		return this;
	}
}

export class IndexedColumn {
	static readonly [entityKind]: string = 'IndexedColumn';
	constructor(
		name: string | undefined,
		keyAsName: boolean,
		type: string,
		indexConfig: IndexedExtraConfigType,
	) {
		this.name = name;
		this.keyAsName = keyAsName;
		this.type = type;
		this.indexConfig = indexConfig;
	}

	name: string | undefined;
	keyAsName: boolean;
	type: string;
	indexConfig: IndexedExtraConfigType;
}

export type AnyHanaColumn<TPartial extends Partial<ColumnBaseConfig<ColumnType>> = {}> = HanaColumn<
	Required<Update<ColumnBaseConfig<ColumnType>, TPartial>>
>;

export type HanaArrayColumnBuilderBaseConfig = ColumnBuilderBaseConfig<'array basecolumn'> & {
	baseBuilder: ColumnBuilderBaseConfig<ColumnType>;
};

export class HanaArrayBuilder<
	T extends HanaArrayColumnBuilderBaseConfig,
	TBase extends ColumnBuilderBaseConfig<ColumnType> | HanaArrayColumnBuilderBaseConfig,
> extends HanaColumnBuilder<
	T & {
		baseBuilder: TBase extends HanaArrayColumnBuilderBaseConfig ? HanaArrayBuilder<
				TBase,
				TBase extends { baseBuilder: infer TBaseBuilder extends ColumnBuilderBaseConfig<any> } ? TBaseBuilder
					: never
			>
			: HanaColumnBuilder<TBase, {}>;
	},
	{
		baseBuilder: TBase extends HanaArrayColumnBuilderBaseConfig ? HanaArrayBuilder<
				TBase,
				TBase extends { baseBuilder: infer TBaseBuilder extends ColumnBuilderBaseConfig<any> } ? TBaseBuilder
					: never
			>
			: HanaColumnBuilder<TBase, {}>;
		length: number | undefined;
	}
> {
	static override readonly [entityKind]: string = 'HanaArrayBuilder';

	constructor(
		name: string,
		baseBuilder: HanaArrayBuilder<T, TBase>['config']['baseBuilder'],
		length: number | undefined,
	) {
		super(name, 'array basecolumn', 'HanaArray');
		this.config.baseBuilder = baseBuilder;
		this.config.length = length;
	}

	/** @internal */
	override build(table: HanaTable) {
		const baseColumn: any = this.config.baseBuilder.build(table);
		return new HanaArray(
			table,
			this.config as any,
			baseColumn,
		);
	}
}

export class HanaArray<
	T extends ColumnBaseConfig<'array basecolumn'> & {
		length: number | undefined;
		baseBuilder: ColumnBuilderBaseConfig<ColumnType>;
	},
	TBase extends ColumnBuilderBaseConfig<ColumnType>,
> extends HanaColumn<T, {}> {
	static override readonly [entityKind]: string = 'HanaArray';

	constructor(
		table: AnyHanaTable<{ name: T['tableName'] }>,
		config: HanaArrayBuilder<T, TBase>['config'],
		readonly baseColumn: HanaColumn,
		readonly range?: [number | undefined, number | undefined],
	) {
		super(table, config);
	}

	getSQLType(): string {
		return `${this.baseColumn.getSQLType()}[${typeof this.length === 'number' ? this.length : ''}]`;
	}

	override mapFromDriverValue(value: unknown[] | string): T['data'] {
		if (typeof value === 'string') {
			// Thank you node-postgres for not parsing enum arrays
			value = parseHanaArray(value);
		}
		return value.map((v) => this.baseColumn.mapFromDriverValue(v));
	}

	// Needed for arrays of custom types
	mapFromJsonValue(value: unknown[] | string): T['data'] {
		if (typeof value === 'string') {
			// Thank you node-postgres for not parsing enum arrays
			value = parseHanaArray(value);
		}

		const base = this.baseColumn;

		return 'mapFromJsonValue' in base
			? value.map((v) => (<(value: unknown) => unknown> base.mapFromJsonValue)(v))
			: value.map((v) => base.mapFromDriverValue(v));
	}

	override mapToDriverValue(value: unknown[], isNestedArray = false): unknown[] | string {
		const a = value.map((v) =>
			v === null
				? null
				: is(this.baseColumn, HanaArray)
				? this.baseColumn.mapToDriverValue(v as unknown[], true)
				: this.baseColumn.mapToDriverValue(v)
		);
		if (isNestedArray) return a;
		return makeHanaArray(a);
	}
}
