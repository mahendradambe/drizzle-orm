import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaSmallDecimalBuilder extends HanaColumnBuilder<{
	dataType: 'string smalldecimal';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaSmallDecimalBuilder';

	constructor(name: string) {
		super(name, 'string smalldecimal', 'HanaSmallDecimal');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaSmallDecimal(table, this.config as any);
	}
}

export class HanaSmallDecimal<T extends ColumnBaseConfig<'string smalldecimal'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaSmallDecimal';

	override mapFromDriverValue(value: unknown): string {
		if (typeof value === 'string') return value;
		return String(value);
	}

	getSQLType(): string {
		return 'smalldecimal';
	}
}

/** HANA SMALLDECIMAL (variable-precision floating decimal, up to 16 bytes; no precision/scale args). */
export function smalldecimal(name?: string): HanaSmallDecimalBuilder {
	return new HanaSmallDecimalBuilder(name ?? '');
}
