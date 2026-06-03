import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn } from './common.ts';
import { HanaDateColumnBaseBuilder } from './date.common.ts';

export class HanaSecondDateBuilder extends HanaDateColumnBaseBuilder<{
	dataType: 'object seconddate';
	data: Date;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaSecondDateBuilder';

	constructor(name: string) {
		super(name, 'object seconddate', 'HanaSecondDate');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaSecondDate(table, this.config as any);
	}
}

export class HanaSecondDate<T extends ColumnBaseConfig<'object seconddate'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaSecondDate';

	getSQLType(): string {
		return 'seconddate';
	}

	override mapFromDriverValue(value: Date | string): Date {
		if (typeof value === 'string') return new Date(value + '+0000');
		return value;
	}

	override mapToDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;
		return value.toISOString();
	}
}

export class HanaSecondDateStringBuilder extends HanaDateColumnBaseBuilder<{
	dataType: 'string seconddate';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaSecondDateStringBuilder';

	constructor(name: string) {
		super(name, 'string seconddate', 'HanaSecondDateString');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaSecondDateString(table, this.config as any);
	}
}

export class HanaSecondDateString<T extends ColumnBaseConfig<'string seconddate'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaSecondDateString';

	getSQLType(): string {
		return 'seconddate';
	}

	override mapFromDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;
		return value.toISOString().slice(0, -1).replace('T', ' ');
	}

	override mapToDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;
		return value.toISOString();
	}
}

export interface HanaSecondDateConfig<TMode extends 'date' | 'string' = 'date' | 'string'> {
	mode?: TMode;
}

export function seconddate<TMode extends HanaSecondDateConfig['mode'] & {}>(
	config?: HanaSecondDateConfig<TMode>,
): Equal<TMode, 'string'> extends true ? HanaSecondDateStringBuilder : HanaSecondDateBuilder;
export function seconddate<TMode extends HanaSecondDateConfig['mode'] & {}>(
	name: string,
	config?: HanaSecondDateConfig<TMode>,
): Equal<TMode, 'string'> extends true ? HanaSecondDateStringBuilder : HanaSecondDateBuilder;
export function seconddate(a?: string | HanaSecondDateConfig, b: HanaSecondDateConfig = {}) {
	const { name, config } = getColumnNameAndConfig<HanaSecondDateConfig | undefined>(a, b);
	if (config?.mode === 'string') {
		return new HanaSecondDateStringBuilder(name);
	}
	return new HanaSecondDateBuilder(name);
}
