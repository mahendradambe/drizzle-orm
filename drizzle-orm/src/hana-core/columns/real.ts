import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaRealBuilder extends HanaColumnBuilder<
	{
		dataType: 'number float';
		data: number;
		driverParam: string | number;
	},
	{ length: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaRealBuilder';

	constructor(name: string, length?: number) {
		super(name, 'number float', 'HanaReal');
		this.config.length = length;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaReal(table, this.config as any);
	}
}

export class HanaReal<T extends ColumnBaseConfig<'number float' | 'number ufloat'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaReal';

	constructor(table: HanaTable<any>, config: HanaRealBuilder['config']) {
		super(table, config);
	}

	getSQLType(): string {
		return 'real';
	}

	override mapFromDriverValue = (value: string | number): number => {
		if (typeof value === 'string') {
			return Number.parseFloat(value);
		}
		return value;
	};
}

export function real(name?: string): HanaRealBuilder {
	return new HanaRealBuilder(name ?? '');
}
