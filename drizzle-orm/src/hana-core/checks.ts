import { entityKind } from '~/entity.ts';
import type { SQL } from '~/sql/index.ts';
import type { HanaTable } from './table.ts';

export class CheckBuilder {
	static readonly [entityKind]: string = 'HanaCheckBuilder';

	protected brand!: 'HanaConstraintBuilder';

	constructor(public name: string, public value: SQL) {}

	/** @internal */
	build(table: HanaTable): Check {
		return new Check(table, this);
	}
}

export class Check {
	static readonly [entityKind]: string = 'HanaCheck';

	readonly name: string;
	readonly value: SQL;

	constructor(public table: HanaTable, builder: CheckBuilder) {
		this.name = builder.name;
		this.value = builder.value;
	}
}

export function check(name: string, value: SQL): CheckBuilder {
	return new CheckBuilder(name, value);
}
