import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn } from './common.ts';
import { HanaIntColumnBaseBuilder } from './int.common.ts';

export class HanaBigInt53Builder extends HanaIntColumnBaseBuilder<{
	dataType: 'number int53';
	data: number;
	driverParam: number | string;
}> {
	static override readonly [entityKind]: string = 'HanaBigInt53Builder';

	constructor(name: string) {
		super(name, 'number int53', 'HanaBigInt53');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBigInt53(table, this.config as any);
	}
}

export class HanaBigInt53<T extends ColumnBaseConfig<'number int53'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBigInt53';

	getSQLType(): string {
		return 'bigint';
	}

	override mapFromDriverValue(value: number | string): number {
		if (typeof value === 'number') {
			return value;
		}
		return Number(value);
	}
}

export class HanaBigInt64Builder extends HanaIntColumnBaseBuilder<{
	dataType: 'bigint int64';
	data: bigint;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaBigInt64Builder';

	constructor(name: string) {
		super(name, 'bigint int64', 'HanaBigInt64');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBigInt64(table, this.config as any);
	}
}

export class HanaBigInt64<T extends ColumnBaseConfig<'bigint int64'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBigInt64';

	getSQLType(): string {
		return 'bigint';
	}

	// eslint-disable-next-line unicorn/prefer-native-coercion-functions
	override mapFromDriverValue(value: string): bigint {
		return BigInt(value);
	}
}

export class HanaBigIntStringBuilder extends HanaIntColumnBaseBuilder<{
	dataType: 'string int64';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaBigIntStringBuilder';

	constructor(name: string) {
		super(name, 'string int64', 'HanaBigIntString');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBigIntString(table, this.config as any);
	}
}

export class HanaBigIntString<T extends ColumnBaseConfig<'string int64'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBigIntString';

	getSQLType(): string {
		return 'bigint';
	}

	override mapFromDriverValue(value: string | number): string {
		if (typeof value === 'string') return value;

		return String(value);
	}
}

export interface HanaBigIntConfig<T extends 'number' | 'bigint' | 'string' = 'number' | 'bigint' | 'string'> {
	mode: T;
}

export function bigint<TMode extends HanaBigIntConfig['mode']>(
	config: HanaBigIntConfig<TMode>,
): TMode extends 'string' ? HanaBigIntStringBuilder
	: TMode extends 'bigint' ? HanaBigInt64Builder
	: HanaBigInt53Builder;
export function bigint<TMode extends HanaBigIntConfig['mode']>(
	name: string,
	config: HanaBigIntConfig<TMode>,
): TMode extends 'string' ? HanaBigIntStringBuilder
	: TMode extends 'bigint' ? HanaBigInt64Builder
	: HanaBigInt53Builder;
export function bigint(a: string | HanaBigIntConfig, b?: HanaBigIntConfig) {
	const { name, config } = getColumnNameAndConfig<HanaBigIntConfig>(a, b);
	if (config.mode === 'number') {
		return new HanaBigInt53Builder(name);
	}
	if (config.mode === 'string') {
		return new HanaBigIntStringBuilder(name);
	}
	return new HanaBigInt64Builder(name);
}
