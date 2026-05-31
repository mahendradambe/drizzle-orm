import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaDoubleBuilder extends HanaColumnBuilder<{
	dataType: 'number double';
	data: number;
	driverParam: string | number;
}> {
	static override readonly [entityKind]: string = 'HanaDoubleBuilder';

	constructor(name: string) {
		super(name, 'number double', 'HanaDouble');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaDouble(
			table,
			this.config,
		);
	}
}

export class HanaDouble<T extends ColumnBaseConfig<'number double'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaDouble';

	getSQLType(): string {
		return 'double';
	}

	override mapFromDriverValue(value: string | number): number {
		if (typeof value === 'string') {
			return Number.parseFloat(value);
		}
		return value;
	}
}

export function double(name?: string): HanaDoubleBuilder {
	return new HanaDoubleBuilder(name ?? '');
}
