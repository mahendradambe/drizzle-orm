import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig, type Writable } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaNVarcharBuilder<
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
	static override readonly [entityKind]: string = 'HanaNVarcharBuilder';

	constructor(name: string, config: HanaNVarcharConfig<TEnum>) {
		super(name, config.enum?.length ? 'string enum' : 'string', 'HanaNVarchar');
		this.config.length = config.length!;
		this.config.enumValues = config.enum!;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaNVarchar(
			table,
			this.config as any,
		);
	}
}

export class HanaNVarchar<T extends ColumnBaseConfig<'string' | 'string enum'>>
	extends HanaColumn<T, { length: number | undefined; enumValues: T['enumValues'] }>
{
	static override readonly [entityKind]: string = 'HanaNVarchar';

	override readonly enumValues = this.config.enumValues;

	getSQLType(): string {
		return this.length === undefined ? `nvarchar` : `nvarchar(${this.length})`;
	}
}

export interface HanaNVarcharConfig<
	TEnum extends readonly string[] | string[] | undefined = readonly string[] | string[] | undefined,
> {
	enum?: TEnum;
	length?: number;
}

export function nvarchar(): HanaNVarcharBuilder<[string, ...string[]]>;
export function nvarchar<
	U extends string,
	T extends Readonly<[U, ...U[]]>,
>(
	config?: HanaNVarcharConfig<T | Writable<T>>,
): HanaNVarcharBuilder<Writable<T>>;
export function nvarchar<
	U extends string,
	T extends Readonly<[U, ...U[]]>,
>(
	name: string,
	config?: HanaNVarcharConfig<T | Writable<T>>,
): HanaNVarcharBuilder<Writable<T>>;
export function nvarchar(a?: string | HanaNVarcharConfig, b: HanaNVarcharConfig = {}): any {
	const { name, config } = getColumnNameAndConfig<HanaNVarcharConfig>(a, b);
	return new HanaNVarcharBuilder(name, config as any);
}
