import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig, type Writable } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaVarcharBuilder<
	TEnum extends [string, ...string[]],
> extends HanaColumnBuilder<
	{
		dataType: Equal<TEnum, [string, ...string[]]> extends true ? 'string' : 'string enum';
		data: TEnum[number];
		driverParam: string;
		enumValues: TEnum;
	},
	{ length: number | undefined; enumValues: TEnum }
> {
	static override readonly [entityKind]: string = 'HanaVarcharBuilder';

	constructor(name: string, config: HanaVarcharConfig<TEnum>) {
		super(name, config.enum?.length ? 'string enum' : 'string', 'HanaVarchar');
		this.config.length = config.length!;
		this.config.enumValues = config.enum!;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaVarchar(
			table,
			this.config as any,
		);
	}
}

export class HanaVarchar<T extends ColumnBaseConfig<'string' | 'string enum'>>
	extends HanaColumn<T, { length: number | undefined; enumValues: T['enumValues'] }>
{
	static override readonly [entityKind]: string = 'HanaVarchar';

	override readonly enumValues = this.config.enumValues;

	getSQLType(): string {
		return this.length === undefined ? `varchar` : `varchar(${this.length})`;
	}
}

export interface HanaVarcharConfig<
	TEnum extends readonly string[] | string[] | undefined = readonly string[] | string[] | undefined,
> {
	enum?: TEnum;
	length?: number;
}

export function varchar(): HanaVarcharBuilder<[string, ...string[]]>;
export function varchar<
	U extends string,
	T extends Readonly<[U, ...U[]]>,
>(
	config?: HanaVarcharConfig<T | Writable<T>>,
): HanaVarcharBuilder<Writable<T>>;
export function varchar<
	U extends string,
	T extends Readonly<[U, ...U[]]>,
>(
	name: string,
	config?: HanaVarcharConfig<T | Writable<T>>,
): HanaVarcharBuilder<Writable<T>>;
export function varchar(a?: string | HanaVarcharConfig, b: HanaVarcharConfig = {}): any {
	const { name, config } = getColumnNameAndConfig<HanaVarcharConfig>(a, b);
	return new HanaVarcharBuilder(name, config as any);
}
