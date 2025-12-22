import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn } from './common.ts';
import { HanaIntColumnBaseBuilder } from './int.common.ts';

export class HanaSmallIntBuilder extends HanaIntColumnBaseBuilder<{
	dataType: 'number int16';
	data: number;
	driverParam: number | string;
}> {
	static override readonly [entityKind]: string = 'HanaSmallIntBuilder';

	constructor(name: string) {
		super(name, 'number int16', 'HanaSmallInt');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaSmallInt(table, this.config as any);
	}
}

export class HanaSmallInt<T extends ColumnBaseConfig<'number int16' | 'number uint16'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaSmallInt';

	getSQLType(): string {
		return 'smallint';
	}

	override mapFromDriverValue = (value: number | string): number => {
		if (typeof value === 'string') {
			return Number(value);
		}
		return value;
	};
}
export function smallint(name?: string): HanaSmallIntBuilder {
	return new HanaSmallIntBuilder(name ?? '');
}
