import type { BuildColumns, ColumnBuilderBase } from '~/column-builder.ts';
import { entityKind, is } from '~/entity.ts';
import type { TypedQueryBuilder } from '~/query-builders/query-builder.ts';
import type { AddAliasToSelection } from '~/query-builders/select.types.ts';
import { SelectionProxyHandler } from '~/selection-proxy.ts';
import type { ColumnsSelection, SQL } from '~/sql/sql.ts';
import type { RequireAtLeastOne } from '~/utils.ts';
import { getTableColumns } from '~/utils.ts';
import type { HanaColumn } from './columns/common.ts';
import { QueryBuilder } from './query-builders/query-builder.ts';
import { hanaTable } from './table.ts';
import { HanaViewBase } from './view-base.ts';
import { HanaMaterializedViewConfig, HanaViewConfig } from './view-common.ts';

export type ViewWithConfig = RequireAtLeastOne<{
	checkOption: 'local' | 'cascaded';
	securityBarrier: boolean;
	securityInvoker: boolean;
}>;

export class DefaultViewBuilderCore<TConfig extends { name: string; columns?: unknown }> {
	static readonly [entityKind]: string = 'HanaDefaultViewBuilderCore';

	declare readonly _: {
		readonly name: TConfig['name'];
		readonly columns: TConfig['columns'];
	};

	constructor(
		protected name: TConfig['name'],
		protected schema: string | undefined,
	) {}

	protected config: {
		with?: ViewWithConfig;
	} = {};

	with(config: ViewWithConfig): this {
		this.config.with = config;
		return this;
	}
}

export class ViewBuilder<TName extends string = string> extends DefaultViewBuilderCore<{ name: TName }> {
	static override readonly [entityKind]: string = 'HanaViewBuilder';

	as<TSelectedFields extends ColumnsSelection>(
		qb: TypedQueryBuilder<TSelectedFields> | ((qb: QueryBuilder) => TypedQueryBuilder<TSelectedFields>),
	): HanaViewWithSelection<TName, false, AddAliasToSelection<TSelectedFields, TName, 'hana'>> {
		if (typeof qb === 'function') {
			qb = qb(new QueryBuilder());
		}
		const selectionProxy = new SelectionProxyHandler<TSelectedFields>({
			alias: this.name,
			sqlBehavior: 'error',
			sqlAliasedBehavior: 'alias',
			replaceOriginalName: true,
		});
		const aliasedSelection = new Proxy(qb.getSelectedFields(), selectionProxy);
		return new Proxy(
			new HanaView({
				hanaConfig: this.config,
				config: {
					name: this.name,
					schema: this.schema,
					selectedFields: aliasedSelection,
					query: qb.getSQL().inlineParams(),
				},
			}),
			selectionProxy as any,
		) as HanaViewWithSelection<TName, false, AddAliasToSelection<TSelectedFields, TName, 'hana'>>;
	}
}

export class ManualViewBuilder<
	TName extends string = string,
	TColumns extends Record<string, ColumnBuilderBase> = Record<string, ColumnBuilderBase>,
> extends DefaultViewBuilderCore<{ name: TName; columns: TColumns }> {
	static override readonly [entityKind]: string = 'HanaManualViewBuilder';

	private columns: Record<string, HanaColumn>;

	constructor(
		name: TName,
		columns: TColumns,
		schema: string | undefined,
	) {
		super(name, schema);
		this.columns = getTableColumns(hanaTable(name, columns));
	}

	existing(): HanaViewWithSelection<TName, true, BuildColumns<TName, TColumns, 'hana'>> {
		return new Proxy(
			new HanaView({
				hanaConfig: undefined,
				config: {
					name: this.name,
					schema: this.schema,
					selectedFields: this.columns,
					query: undefined,
				},
			}),
			new SelectionProxyHandler({
				alias: this.name,
				sqlBehavior: 'error',
				sqlAliasedBehavior: 'alias',
				replaceOriginalName: true,
			}),
		) as HanaViewWithSelection<TName, true, BuildColumns<TName, TColumns, 'hana'>>;
	}

	as(query: SQL): HanaViewWithSelection<TName, false, BuildColumns<TName, TColumns, 'hana'>> {
		return new Proxy(
			new HanaView({
				hanaConfig: this.config,
				config: {
					name: this.name,
					schema: this.schema,
					selectedFields: this.columns,
					query: query.inlineParams(),
				},
			}),
			new SelectionProxyHandler({
				alias: this.name,
				sqlBehavior: 'error',
				sqlAliasedBehavior: 'alias',
				replaceOriginalName: true,
			}),
		) as HanaViewWithSelection<TName, false, BuildColumns<TName, TColumns, 'hana'>>;
	}
}

export type HanaMaterializedViewWithConfig = RequireAtLeastOne<{
	fillfactor: number;
	toastTupleTarget: number;
	parallelWorkers: number;
	autovacuumEnabled: boolean;
	vacuumIndexCleanup: 'auto' | 'off' | 'on';
	vacuumTruncate: boolean;
	autovacuumVacuumThreshold: number;
	autovacuumVacuumScaleFactor: number;
	autovacuumVacuumCostDelay: number;
	autovacuumVacuumCostLimit: number;
	autovacuumFreezeMinAge: number;
	autovacuumFreezeMaxAge: number;
	autovacuumFreezeTableAge: number;
	autovacuumMultixactFreezeMinAge: number;
	autovacuumMultixactFreezeMaxAge: number;
	autovacuumMultixactFreezeTableAge: number;
	logAutovacuumMinDuration: number;
	userCatalogTable: boolean;
}>;

export class MaterializedViewBuilderCore<TConfig extends { name: string; columns?: unknown }> {
	static readonly [entityKind]: string = 'HanaMaterializedViewBuilderCore';

	declare _: {
		readonly name: TConfig['name'];
		readonly columns: TConfig['columns'];
	};

	constructor(
		protected name: TConfig['name'],
		protected schema: string | undefined,
	) {}

	protected config: {
		with?: HanaMaterializedViewWithConfig;
		using?: string;
		tablespace?: string;
		withNoData?: boolean;
	} = {};

	using(using: string): this {
		this.config.using = using;
		return this;
	}

	with(config: HanaMaterializedViewWithConfig): this {
		this.config.with = config;
		return this;
	}

	tablespace(tablespace: string): this {
		this.config.tablespace = tablespace;
		return this;
	}

	withNoData(): this {
		this.config.withNoData = true;
		return this;
	}
}

export class MaterializedViewBuilder<TName extends string = string>
	extends MaterializedViewBuilderCore<{ name: TName }>
{
	static override readonly [entityKind]: string = 'HanaMaterializedViewBuilder';

	as<TSelectedFields extends ColumnsSelection>(
		qb: TypedQueryBuilder<TSelectedFields> | ((qb: QueryBuilder) => TypedQueryBuilder<TSelectedFields>),
	): HanaMaterializedViewWithSelection<TName, false, AddAliasToSelection<TSelectedFields, TName, 'hana'>> {
		if (typeof qb === 'function') {
			qb = qb(new QueryBuilder());
		}
		const selectionProxy = new SelectionProxyHandler<TSelectedFields>({
			alias: this.name,
			sqlBehavior: 'error',
			sqlAliasedBehavior: 'alias',
			replaceOriginalName: true,
		});
		const aliasedSelection = new Proxy(qb.getSelectedFields(), selectionProxy);
		return new Proxy(
			new HanaMaterializedView({
				hanaConfig: {
					with: this.config.with,
					using: this.config.using,
					tablespace: this.config.tablespace,
					withNoData: this.config.withNoData,
				},
				config: {
					name: this.name,
					schema: this.schema,
					selectedFields: aliasedSelection,
					query: qb.getSQL().inlineParams(),
				},
			}),
			selectionProxy as any,
		) as HanaMaterializedViewWithSelection<TName, false, AddAliasToSelection<TSelectedFields, TName, 'hana'>>;
	}
}

export class ManualMaterializedViewBuilder<
	TName extends string = string,
	TColumns extends Record<string, ColumnBuilderBase> = Record<string, ColumnBuilderBase>,
> extends MaterializedViewBuilderCore<{ name: TName; columns: TColumns }> {
	static override readonly [entityKind]: string = 'HanaManualMaterializedViewBuilder';

	private columns: Record<string, HanaColumn>;

	constructor(
		name: TName,
		columns: TColumns,
		schema: string | undefined,
	) {
		super(name, schema);
		this.columns = getTableColumns(hanaTable(name, columns));
	}

	existing(): HanaMaterializedViewWithSelection<TName, true, BuildColumns<TName, TColumns, 'hana'>> {
		return new Proxy(
			new HanaMaterializedView({
				hanaConfig: {
					tablespace: this.config.tablespace,
					using: this.config.using,
					with: this.config.with,
					withNoData: this.config.withNoData,
				},
				config: {
					name: this.name,
					schema: this.schema,
					selectedFields: this.columns,
					query: undefined,
				},
			}),
			new SelectionProxyHandler({
				alias: this.name,
				sqlBehavior: 'error',
				sqlAliasedBehavior: 'alias',
				replaceOriginalName: true,
			}),
		) as HanaMaterializedViewWithSelection<TName, true, BuildColumns<TName, TColumns, 'hana'>>;
	}

	as(query: SQL): HanaMaterializedViewWithSelection<TName, false, BuildColumns<TName, TColumns, 'hana'>> {
		return new Proxy(
			new HanaMaterializedView({
				hanaConfig: {
					tablespace: this.config.tablespace,
					using: this.config.using,
					with: this.config.with,
					withNoData: this.config.withNoData,
				},
				config: {
					name: this.name,
					schema: this.schema,
					selectedFields: this.columns,
					query: query.inlineParams(),
				},
			}),
			new SelectionProxyHandler({
				alias: this.name,
				sqlBehavior: 'error',
				sqlAliasedBehavior: 'alias',
				replaceOriginalName: true,
			}),
		) as HanaMaterializedViewWithSelection<TName, false, BuildColumns<TName, TColumns, 'hana'>>;
	}
}

export class HanaView<
	TName extends string = string,
	TExisting extends boolean = boolean,
	TSelectedFields extends ColumnsSelection = ColumnsSelection,
> extends HanaViewBase<TName, TExisting, TSelectedFields> {
	static override readonly [entityKind]: string = 'HanaView';

	[HanaViewConfig]: {
		with?: ViewWithConfig;
	} | undefined;

	constructor({ hanaConfig, config }: {
		hanaConfig: {
			with?: ViewWithConfig;
		} | undefined;
		config: {
			name: TName;
			schema: string | undefined;
			selectedFields: ColumnsSelection;
			query: SQL | undefined;
		};
	}) {
		super(config);
		if (hanaConfig) {
			this[HanaViewConfig] = {
				with: hanaConfig.with,
			};
		}
	}
}

export type HanaViewWithSelection<
	TName extends string = string,
	TExisting extends boolean = boolean,
	TSelectedFields extends ColumnsSelection = ColumnsSelection,
> = HanaView<TName, TExisting, TSelectedFields> & TSelectedFields;

export class HanaMaterializedView<
	TName extends string = string,
	TExisting extends boolean = boolean,
	TSelectedFields extends ColumnsSelection = ColumnsSelection,
> extends HanaViewBase<TName, TExisting, TSelectedFields> {
	static override readonly [entityKind]: string = 'HanaMaterializedView';

	readonly [HanaMaterializedViewConfig]: {
		readonly with?: HanaMaterializedViewWithConfig;
		readonly using?: string;
		readonly tablespace?: string;
		readonly withNoData?: boolean;
	} | undefined;

	constructor({ hanaConfig, config }: {
		hanaConfig: {
			with: HanaMaterializedViewWithConfig | undefined;
			using: string | undefined;
			tablespace: string | undefined;
			withNoData: boolean | undefined;
		} | undefined;
		config: {
			name: TName;
			schema: string | undefined;
			selectedFields: ColumnsSelection;
			query: SQL | undefined;
		};
	}) {
		super(config);
		this[HanaMaterializedViewConfig] = {
			with: hanaConfig?.with,
			using: hanaConfig?.using,
			tablespace: hanaConfig?.tablespace,
			withNoData: hanaConfig?.withNoData,
		};
	}
}

export type HanaMaterializedViewWithSelection<
	TName extends string = string,
	TExisting extends boolean = boolean,
	TSelectedFields extends ColumnsSelection = ColumnsSelection,
> = HanaMaterializedView<TName, TExisting, TSelectedFields> & TSelectedFields;

/** @internal */
export function hanaViewWithSchema(
	name: string,
	selection: Record<string, ColumnBuilderBase> | undefined,
	schema: string | undefined,
): ViewBuilder | ManualViewBuilder {
	if (selection) {
		return new ManualViewBuilder(name, selection, schema);
	}
	return new ViewBuilder(name, schema);
}

/** @internal */
export function hanaMaterializedViewWithSchema(
	name: string,
	selection: Record<string, ColumnBuilderBase> | undefined,
	schema: string | undefined,
): MaterializedViewBuilder | ManualMaterializedViewBuilder {
	if (selection) {
		return new ManualMaterializedViewBuilder(name, selection, schema);
	}
	return new MaterializedViewBuilder(name, schema);
}

export function hanaView<TName extends string>(name: TName): ViewBuilder<TName>;
export function hanaView<TName extends string, TColumns extends Record<string, ColumnBuilderBase>>(
	name: TName,
	columns: TColumns,
): ManualViewBuilder<TName, TColumns>;
export function hanaView(name: string, columns?: Record<string, ColumnBuilderBase>): ViewBuilder | ManualViewBuilder {
	return hanaViewWithSchema(name, columns, undefined);
}

export function hanaMaterializedView<TName extends string>(name: TName): MaterializedViewBuilder<TName>;
export function hanaMaterializedView<TName extends string, TColumns extends Record<string, ColumnBuilderBase>>(
	name: TName,
	columns: TColumns,
): ManualMaterializedViewBuilder<TName, TColumns>;
export function hanaMaterializedView(
	name: string,
	columns?: Record<string, ColumnBuilderBase>,
): MaterializedViewBuilder | ManualMaterializedViewBuilder {
	return hanaMaterializedViewWithSchema(name, columns, undefined);
}

export function isHanaView(obj: unknown): obj is HanaView {
	return is(obj, HanaView);
}

export function isHanaMaterializedView(obj: unknown): obj is HanaMaterializedView {
	return is(obj, HanaMaterializedView);
}
