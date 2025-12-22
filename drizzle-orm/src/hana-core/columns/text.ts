import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig, type Writable } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaTextBuilder<TEnum extends [string, ...string[]] = [string, ...string[]]> extends HanaColumnBuilder<{
	dataType: Equal<TEnum, [string, ...string[]]> extends true ? 'string' : 'string enum';
	data: TEnum[number];
	enumValues: TEnum;
	driverParam: string;
}, { enumValues: TEnum | undefined }> {
	static override readonly [entityKind]: string = 'HanaTextBuilder';

	constructor(
		name: string,
		config: HanaTextConfig<TEnum>,
	) {
		super(name, config.enum?.length ? 'string enum' : 'string', 'HanaText');
		this.config.enumValues = config.enum;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaText(table, this.config as any, this.config.enumValues);
	}
}

export class HanaText<T extends ColumnBaseConfig<'string' | 'string enum'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaText';
	override readonly enumValues;

	constructor(
		table: HanaTable<any>,
		config: any,
		enumValues?: string[],
	) {
		super(table, config);
		this.enumValues = enumValues;
	}

	getSQLType(): string {
		return 'text';
	}
}

export interface HanaTextConfig<
	TEnum extends readonly string[] | undefined = readonly string[] | undefined,
> {
	enum?: TEnum;
}

export function text<U extends string, T extends Readonly<[U, ...U[]]>>(
	config?: HanaTextConfig<T | Writable<T>>,
): HanaTextBuilder<Writable<T>>;
export function text<U extends string, T extends Readonly<[U, ...U[]]>>(
	name: string,
	config?: HanaTextConfig<T | Writable<T>>,
): HanaTextBuilder<Writable<T>>;
export function text(a?: string | HanaTextConfig, b: HanaTextConfig = {}): any {
	const { name, config } = getColumnNameAndConfig<HanaTextConfig>(a, b);
	return new HanaTextBuilder(name, config as any);
}
