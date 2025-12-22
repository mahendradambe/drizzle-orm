import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn } from './common.ts';
import { HanaDateColumnBaseBuilder } from './date.common.ts';

export class HanaDateBuilder extends HanaDateColumnBaseBuilder<{
	dataType: 'object date';
	data: Date;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaDateBuilder';

	constructor(name: string) {
		super(name, 'object date', 'HanaDate');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaDate(table, this.config as any);
	}
}

export class HanaDate<T extends ColumnBaseConfig<'object date'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaDate';

	getSQLType(): string {
		return 'date';
	}

	override mapFromDriverValue(value: string | Date): Date {
		if (typeof value === 'string') return new Date(value);
		return value;
	}

	override mapToDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;
		return value.toISOString();
	}
}

export class HanaDateStringBuilder extends HanaDateColumnBaseBuilder<{
	dataType: 'string date';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaDateStringBuilder';

	constructor(name: string) {
		super(name, 'string date', 'HanaDateString');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaDateString(
			table,
			this.config as any,
		);
	}
}

export class HanaDateString<T extends ColumnBaseConfig<'string date'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaDateString';

	getSQLType(): string {
		return 'date';
	}

	override mapFromDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;
		return value.toISOString().slice(0, -14);
	}

	override mapToDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;
		return value.toISOString();
	}
}

export interface HanaDateConfig<T extends 'date' | 'string' = 'date' | 'string'> {
	mode: T;
}

export function date<TMode extends HanaDateConfig['mode'] & {}>(
	config?: HanaDateConfig<TMode>,
): Equal<TMode, 'date'> extends true ? HanaDateBuilder : HanaDateStringBuilder;
export function date<TMode extends HanaDateConfig['mode'] & {}>(
	name: string,
	config?: HanaDateConfig<TMode>,
): Equal<TMode, 'date'> extends true ? HanaDateBuilder : HanaDateStringBuilder;
export function date(a?: string | HanaDateConfig, b?: HanaDateConfig) {
	const { name, config } = getColumnNameAndConfig<HanaDateConfig>(a, b);
	if (config?.mode === 'date') {
		return new HanaDateBuilder(name);
	}
	return new HanaDateStringBuilder(name);
}
