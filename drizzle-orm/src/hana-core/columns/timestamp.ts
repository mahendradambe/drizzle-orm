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
	{ withTimezone: boolean; precision: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaTimestampBuilder';

	constructor(
		name: string,
		withTimezone: boolean,
		precision: number | undefined,
	) {
		super(name, 'object date', 'HanaTimestamp');
		this.config.withTimezone = withTimezone;
		this.config.precision = precision;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaTimestamp(table, this.config as any);
	}
}

export class HanaTimestamp<T extends ColumnBaseConfig<'object date'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaTimestamp';

	readonly withTimezone: boolean;
	readonly precision: number | undefined;

	constructor(table: HanaTable<any>, config: HanaTimestampBuilder['config']) {
		super(table, config);
		this.withTimezone = config.withTimezone;
		this.precision = config.precision;
	}

	getSQLType(): string {
		const precision = this.precision === undefined ? '' : ` (${this.precision})`;
		return `timestamp${precision}${this.withTimezone ? ' with time zone' : ''}`;
	}

	override mapFromDriverValue(value: Date | string): Date {
		if (typeof value === 'string') return new Date(this.withTimezone ? value : value + '+0000');

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
	{ withTimezone: boolean; precision: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaTimestampStringBuilder';

	constructor(
		name: string,
		withTimezone: boolean,
		precision: number | undefined,
	) {
		super(name, 'string timestamp', 'HanaTimestampString');
		this.config.withTimezone = withTimezone;
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

	readonly withTimezone: boolean;
	readonly precision: number | undefined;

	constructor(table: HanaTable<any>, config: HanaTimestampStringBuilder['config']) {
		super(table, config);
		this.withTimezone = config.withTimezone;
		this.precision = config.precision;
	}

	getSQLType(): string {
		const precision = this.precision === undefined ? '' : `(${this.precision})`;
		return `timestamp${precision}${this.withTimezone ? ' with time zone' : ''}`;
	}

	override mapFromDriverValue(value: Date | string): string {
		if (typeof value === 'string') return value;

		const shortened = value.toISOString().slice(0, -1).replace('T', ' ');
		if (this.withTimezone) {
			const offset = value.getTimezoneOffset();
			const sign = offset <= 0 ? '+' : '-';
			return `${shortened}${sign}${Math.floor(Math.abs(offset) / 60).toString().padStart(2, '0')}`;
		}

		return shortened;
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
	withTimezone?: boolean;
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
		return new HanaTimestampStringBuilder(name, config.withTimezone ?? false, config.precision);
	}
	return new HanaTimestampBuilder(name, config?.withTimezone ?? false, config?.precision);
}
