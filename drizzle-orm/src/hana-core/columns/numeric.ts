import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaNumericBuilder extends HanaColumnBuilder<
	{
		dataType: 'string numeric';
		data: string;
		driverParam: string;
	},
	{
		precision: number | undefined;
		scale: number | undefined;
	}
> {
	static override readonly [entityKind]: string = 'HanaNumericBuilder';

	constructor(name: string, precision?: number, scale?: number) {
		super(name, 'string numeric', 'HanaNumeric');
		this.config.precision = precision;
		this.config.scale = scale;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaNumeric(table, this.config as any);
	}
}

export class HanaNumeric<T extends ColumnBaseConfig<'string numeric'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaNumeric';

	readonly precision: number | undefined;
	readonly scale: number | undefined;

	constructor(table: HanaTable<any>, config: HanaNumericBuilder['config']) {
		super(table, config);
		this.precision = config.precision;
		this.scale = config.scale;
	}

	override mapFromDriverValue(value: unknown): string {
		if (typeof value === 'string') return value;

		return String(value);
	}

	getSQLType(): string {
		if (this.precision !== undefined && this.scale !== undefined) {
			return `decimal(${this.precision}, ${this.scale})`;
		} else if (this.precision === undefined) {
			return 'decimal';
		} else {
			return `decimal(${this.precision})`;
		}
	}
}

export class HanaNumericNumberBuilder extends HanaColumnBuilder<
	{
		dataType: 'number';
		data: number;
		driverParam: string;
	},
	{
		precision: number | undefined;
		scale: number | undefined;
	}
> {
	static override readonly [entityKind]: string = 'HanaNumericNumberBuilder';

	constructor(name: string, precision?: number, scale?: number) {
		super(name, 'number', 'HanaNumericNumber');
		this.config.precision = precision;
		this.config.scale = scale;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaNumericNumber(
			table,
			this.config as any,
		);
	}
}

export class HanaNumericNumber<T extends ColumnBaseConfig<'number'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaNumericNumber';

	readonly precision: number | undefined;
	readonly scale: number | undefined;

	constructor(table: HanaTable<any>, config: HanaNumericNumberBuilder['config']) {
		super(table, config);
		this.precision = config.precision;
		this.scale = config.scale;
	}

	override mapFromDriverValue(value: unknown): number {
		if (typeof value === 'number') return value;

		return Number(value);
	}

	override mapToDriverValue = String;

	getSQLType(): string {
		if (this.precision !== undefined && this.scale !== undefined) {
			return `decimal(${this.precision}, ${this.scale})`;
		} else if (this.precision === undefined) {
			return 'decimal';
		} else {
			return `decimal(${this.precision})`;
		}
	}
}

export class HanaNumericBigIntBuilder extends HanaColumnBuilder<
	{
		dataType: 'bigint int64';
		data: bigint;
		driverParam: string;
	},
	{
		precision: number | undefined;
		scale: number | undefined;
	}
> {
	static override readonly [entityKind]: string = 'HanaNumericBigIntBuilder';

	constructor(name: string, precision?: number, scale?: number) {
		super(name, 'bigint int64', 'HanaNumericBigInt');
		this.config.precision = precision;
		this.config.scale = scale;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaNumericBigInt(
			table,
			this.config as any,
		);
	}
}

export class HanaNumericBigInt<T extends ColumnBaseConfig<'bigint int64'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaNumericBigInt';

	readonly precision: number | undefined;
	readonly scale: number | undefined;

	constructor(table: HanaTable<any>, config: HanaNumericBigIntBuilder['config']) {
		super(table, config);
		this.precision = config.precision;
		this.scale = config.scale;
	}

	override mapFromDriverValue = BigInt;

	override mapToDriverValue = String;

	getSQLType(): string {
		if (this.precision !== undefined && this.scale !== undefined) {
			return `decimal(${this.precision}, ${this.scale})`;
		} else if (this.precision === undefined) {
			return 'decimal';
		} else {
			return `decimal(${this.precision})`;
		}
	}
}

export type HanaNumericConfig<T extends 'string' | 'number' | 'bigint' = 'string' | 'number' | 'bigint'> =
	| { precision: number; scale?: number; mode?: T }
	| { precision?: number; scale: number; mode?: T }
	| { precision?: number; scale?: number; mode: T };

export function numeric<TMode extends 'string' | 'number' | 'bigint'>(
	config?: HanaNumericConfig<TMode>,
): Equal<TMode, 'number'> extends true ? HanaNumericNumberBuilder
	: Equal<TMode, 'bigint'> extends true ? HanaNumericBigIntBuilder
	: HanaNumericBuilder;
export function numeric<TMode extends 'string' | 'number' | 'bigint'>(
	name: string,
	config?: HanaNumericConfig<TMode>,
): Equal<TMode, 'number'> extends true ? HanaNumericNumberBuilder
	: Equal<TMode, 'bigint'> extends true ? HanaNumericBigIntBuilder
	: HanaNumericBuilder;
export function numeric(a?: string | HanaNumericConfig, b?: HanaNumericConfig) {
	const { name, config } = getColumnNameAndConfig<HanaNumericConfig>(a, b);
	const mode = config?.mode;
	return mode === 'number'
		? new HanaNumericNumberBuilder(name, config?.precision, config?.scale)
		: mode === 'bigint'
		? new HanaNumericBigIntBuilder(name, config?.precision, config?.scale)
		: new HanaNumericBuilder(name, config?.precision, config?.scale);
}

export const decimal = numeric;
