import { entityKind } from '~/entity.ts';
import type { AnyHanaColumn, HanaColumn } from './columns/index.ts';
import { HanaTable } from './table.ts';

export function primaryKey<
	TTableName extends string,
	TColumn extends AnyHanaColumn<{ tableName: TTableName }>,
	TColumns extends AnyHanaColumn<{ tableName: TTableName }>[],
>(config: { name?: string; columns: [TColumn, ...TColumns] }): PrimaryKeyBuilder {
	return new PrimaryKeyBuilder(config.columns, config.name);
}

export class PrimaryKeyBuilder {
	static readonly [entityKind]: string = 'HanaPrimaryKeyBuilder';

	/** @internal */
	columns: HanaColumn[];

	/** @internal */
	name?: string;

	constructor(
		columns: HanaColumn[],
		name?: string,
	) {
		this.columns = columns;
		this.name = name;
	}

	/** @internal */
	build(table: HanaTable): PrimaryKey {
		return new PrimaryKey(table, this.columns, this.name);
	}
}

export class PrimaryKey {
	static readonly [entityKind]: string = 'HanaPrimaryKey';

	readonly columns: AnyHanaColumn<{}>[];
	readonly name?: string;
	readonly isNameExplicit: boolean;

	constructor(readonly table: HanaTable, columns: AnyHanaColumn<{}>[], name?: string) {
		this.columns = columns;
		this.name = name;
		this.isNameExplicit = !!name;
	}

	getName(): string {
		return this.name
			?? `${this.table[HanaTable.Symbol.Name]}_${this.columns.map((column) => column.name).join('_')}_pk`;
	}
}
