import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaDoublePrecisionBuilder extends HanaColumnBuilder<{
	dataType: 'number double';
	data: number;
	driverParam: string | number;
}> {
	static override readonly [entityKind]: string = 'HanaDoublePrecisionBuilder';

	constructor(name: string) {
		super(name, 'number double', 'HanaDoublePrecision');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaDoublePrecision(
			table,
			this.config,
		);
	}
}

export class HanaDoublePrecision<T extends ColumnBaseConfig<'number double'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaDoublePrecision';

	getSQLType(): string {
		return 'double precision';
	}

	override mapFromDriverValue(value: string | number): number {
		if (typeof value === 'string') {
			return Number.parseFloat(value);
		}
		return value;
	}
}

export function doublePrecision(name?: string): HanaDoublePrecisionBuilder {
	return new HanaDoublePrecisionBuilder(name ?? '');
}
