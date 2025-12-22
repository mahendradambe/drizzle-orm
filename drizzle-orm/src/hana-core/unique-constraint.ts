import { entityKind } from '~/entity.ts';
import { TableName } from '~/table.utils.ts';
import type { HanaColumn } from './columns/index.ts';
import type { HanaTable } from './table.ts';

export function unique(name?: string): UniqueOnConstraintBuilder {
	return new UniqueOnConstraintBuilder(name);
}

export function uniqueKeyName(table: HanaTable, columns: string[]) {
	return `${table[TableName]}_${columns.join('_')}_unique`;
}

export class UniqueConstraintBuilder {
	static readonly [entityKind]: string = 'HanaUniqueConstraintBuilder';

	/** @internal */
	columns: HanaColumn[];
	/** @internal */
	nullsNotDistinctConfig = false;

	constructor(
		columns: HanaColumn[],
		private name?: string,
	) {
		this.columns = columns;
	}

	nullsNotDistinct() {
		this.nullsNotDistinctConfig = true;
		return this;
	}

	/** @internal */
	build(table: HanaTable): UniqueConstraint {
		return new UniqueConstraint(table, this.columns, this.nullsNotDistinctConfig, this.name);
	}
}

export class UniqueOnConstraintBuilder {
	static readonly [entityKind]: string = 'HanaUniqueOnConstraintBuilder';

	/** @internal */
	name?: string;

	constructor(
		name?: string,
	) {
		this.name = name;
	}

	on(...columns: [HanaColumn, ...HanaColumn[]]) {
		return new UniqueConstraintBuilder(columns, this.name);
	}
}

export class UniqueConstraint {
	static readonly [entityKind]: string = 'HanaUniqueConstraint';

	readonly columns: HanaColumn[];
	readonly name?: string;
	readonly isNameExplicit: boolean;
	readonly nullsNotDistinct: boolean = false;

	constructor(readonly table: HanaTable, columns: HanaColumn[], nullsNotDistinct: boolean, name?: string) {
		this.columns = columns;
		this.name = name ?? uniqueKeyName(this.table, this.columns.map((column) => column.name));
		this.isNameExplicit = !!name;
		this.nullsNotDistinct = nullsNotDistinct;
	}

	getName() {
		return this.name;
	}
}
