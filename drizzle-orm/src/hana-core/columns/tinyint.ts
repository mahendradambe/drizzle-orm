import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn } from './common.ts';
import { HanaIntColumnBaseBuilder } from './int.common.ts';

export class HanaTinyIntBuilder extends HanaIntColumnBaseBuilder<{
	dataType: 'number uint8';
	data: number;
	driverParam: number | string;
}> {
	static override readonly [entityKind]: string = 'HanaTinyIntBuilder';

	constructor(name: string) {
		super(name, 'number uint8', 'HanaTinyInt');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaTinyInt(table, this.config as any);
	}
}

export class HanaTinyInt<T extends ColumnBaseConfig<'number int8' | 'number uint8'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaTinyInt';

	getSQLType(): string {
		return 'tinyint';
	}

	override mapFromDriverValue = (value: number | string): number => {
		if (typeof value === 'string') {
			return Number(value);
		}
		return value;
	};
}

/** HANA TINYINT (unsigned 1-byte integer, range 0..255). */
export function tinyint(name?: string): HanaTinyIntBuilder {
	return new HanaTinyIntBuilder(name ?? '');
}
