import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn } from './common.ts';
import { HanaDateColumnBaseBuilder } from './date.common.ts';

export class HanaTimestampBuilder extends HanaDateColumnBaseBuilder<
	{
		dataType: 'object date';
		data: Date;
		driverParam: string;
	},
	{ precision: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaTimestampBuilder';

	constructor(
		name: string,
		precision: number | undefined,
	) {
		super(name, 'object date', 'HanaTimestamp');
		this.config.precision = precision;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaTimestamp(table, this.config as any);
	}
}

export class HanaTimestamp<T extends ColumnBaseConfig<'object date'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaTimestamp';

	readonly precision: number | undefined;

	constructor(table: HanaTable<any>, config: HanaTimestampBuilder['config']) {
		super(table, config);
		this.precision = config.precision;
	}

	getSQLType(): string {
		const precision = this.precision === undefined ? '' : ` (${this.precision})`;
		return `timestamp${precision}`;
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

export class HanaTimestampStringBuilder extends HanaDateColumnBaseBuilder<
	{
		dataType: 'string timestamp';
		data: string;
		driverParam: string;
	},
	{ precision: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaTimestampStringBuilder';

	constructor(
		name: string,
		precision: number | undefined,
	) {
		super(name, 'string timestamp', 'HanaTimestampString');
		this.config.precision = precision;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaTimestampString(
			table,
			this.config as any,
		);
	}
}

export class HanaTimestampString<T extends ColumnBaseConfig<'string timestamp'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaTimestampString';

	readonly precision: number | undefined;

	constructor(table: HanaTable<any>, config: HanaTimestampStringBuilder['config']) {
		super(table, config);
		this.precision = config.precision;
	}

	getSQLType(): string {
		const precision = this.precision === undefined ? '' : `(${this.precision})`;
		return `timestamp${precision}`;
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

export type Precision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface HanaTimestampConfig<TMode extends 'date' | 'string' = 'date' | 'string'> {
	mode?: TMode;
	precision?: Precision;
}

export function timestamp<TMode extends HanaTimestampConfig['mode'] & {}>(
	config?: HanaTimestampConfig<TMode>,
): Equal<TMode, 'string'> extends true ? HanaTimestampStringBuilder : HanaTimestampBuilder;
export function timestamp<TMode extends HanaTimestampConfig['mode'] & {}>(
	name: string,
	config?: HanaTimestampConfig<TMode>,
): Equal<TMode, 'string'> extends true ? HanaTimestampStringBuilder : HanaTimestampBuilder;
export function timestamp(a?: string | HanaTimestampConfig, b: HanaTimestampConfig = {}) {
	const { name, config } = getColumnNameAndConfig<HanaTimestampConfig | undefined>(a, b);
	if (config?.mode === 'string') {
		return new HanaTimestampStringBuilder(name, config.precision);
	}
	return new HanaTimestampBuilder(name, config?.precision);
}
