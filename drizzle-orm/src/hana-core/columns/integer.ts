import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '../table.ts';
import { HanaColumn } from './common.ts';
import { HanaIntColumnBaseBuilder } from './int.common.ts';

export class HanaIntegerBuilder extends HanaIntColumnBaseBuilder<{
	dataType: 'number int32';
	data: number;
	driverParam: number | string;
}> {
	static override readonly [entityKind]: string = 'HanaIntegerBuilder';

	constructor(name: string) {
		super(name, 'number int32', 'HanaInteger');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaInteger(table, this.config as any);
	}
}

export class HanaInteger<T extends ColumnBaseConfig<'number int32'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaInteger';

	getSQLType(): string {
		return 'integer';
	}

	override mapFromDriverValue(value: number | string): number {
		if (typeof value === 'string') {
			return Number.parseInt(value);
		}
		return value;
	}
}
export function integer(name?: string): HanaIntegerBuilder {
	return new HanaIntegerBuilder(name ?? '');
}
