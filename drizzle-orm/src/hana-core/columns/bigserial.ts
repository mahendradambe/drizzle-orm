import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import type { HanaTable } from '../table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaBigSerial53Builder extends HanaColumnBuilder<{
	dataType: 'number int53';
	data: number;
	driverParam: number;

	notNull: true;
	hasDefault: true;
}> {
	static override readonly [entityKind]: string = 'HanaBigSerial53Builder';

	constructor(name: string) {
		super(name, 'number int53', 'HanaBigSerial53');
		this.config.hasDefault = true;
		this.config.notNull = true;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBigSerial53(
			table,
			this.config as any,
		);
	}
}

export class HanaBigSerial53<T extends ColumnBaseConfig<'number int53'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBigSerial53';

	getSQLType(): string {
		return 'bigserial';
	}

	override mapFromDriverValue(value: number): number {
		if (typeof value === 'number') {
			return value;
		}
		return Number(value);
	}
}

export class HanaBigSerial64Builder extends HanaColumnBuilder<{
	dataType: 'bigint int64';
	data: bigint;
	driverParam: string;
	notNull: true;
	hasDefault: true;
}> {
	static override readonly [entityKind]: string = 'HanaBigSerial64Builder';

	constructor(name: string) {
		super(name, 'bigint int64', 'HanaBigSerial64');
		this.config.hasDefault = true;
		this.config.notNull = true;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBigSerial64(
			table,
			this.config as any,
		);
	}
}

export class HanaBigSerial64<T extends ColumnBaseConfig<'bigint int64'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBigSerial64';

	getSQLType(): string {
		return 'bigserial';
	}

	// eslint-disable-next-line unicorn/prefer-native-coercion-functions
	override mapFromDriverValue(value: string): bigint {
		return BigInt(value);
	}
}

export interface HanaBigSerialConfig<T extends 'number' | 'bigint' = 'number' | 'bigint'> {
	mode: T;
}

export function bigserial<TMode extends HanaBigSerialConfig['mode']>(
	config: HanaBigSerialConfig<TMode>,
): TMode extends 'number' ? HanaBigSerial53Builder : HanaBigSerial64Builder;
export function bigserial<TMode extends HanaBigSerialConfig['mode']>(
	name: string,
	config: HanaBigSerialConfig<TMode>,
): TMode extends 'number' ? HanaBigSerial53Builder : HanaBigSerial64Builder;
export function bigserial(a: string | HanaBigSerialConfig, b?: HanaBigSerialConfig) {
	const { name, config } = getColumnNameAndConfig<HanaBigSerialConfig>(a, b);
	if (config.mode === 'number') {
		return new HanaBigSerial53Builder(name);
	}
	return new HanaBigSerial64Builder(name);
}
