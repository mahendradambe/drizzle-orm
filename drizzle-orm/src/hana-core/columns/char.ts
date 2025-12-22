import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig, type Writable } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaCharBuilder<
	TEnum extends [string, ...string[]],
> extends HanaColumnBuilder<{
	dataType: Equal<TEnum, [string, ...string[]]> extends true ? 'string' : 'string enum';
	data: TEnum[number];
	enumValues: TEnum;
	driverParam: string;
}, { enumValues?: TEnum; length: number; setLength: boolean }> {
	static override readonly [entityKind]: string = 'HanaCharBuilder';

	constructor(name: string, config: HanaCharConfig<TEnum>) {
		super(name, config.enum?.length ? 'string enum' : 'string', 'HanaChar');
		this.config.length = config.length ?? 1;
		this.config.setLength = config.length !== undefined;
		this.config.enumValues = config.enum;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaChar(
			table,
			this.config as any,
		);
	}
}

export class HanaChar<T extends ColumnBaseConfig<'string' | 'string enum'>>
	extends HanaColumn<T, { enumValues?: T['enumValues']; length: number; setLength: boolean }>
{
	static override readonly [entityKind]: string = 'HanaChar';

	override readonly enumValues = this.config.enumValues;

	getSQLType(): string {
		return this.config.setLength ? `char(${this.length})` : `char`;
	}
}

export interface HanaCharConfig<
	TEnum extends readonly string[] | string[] | undefined = readonly string[] | string[] | undefined,
> {
	enum?: TEnum;
	length?: number;
}

export function char<U extends string, T extends Readonly<[U, ...U[]]>>(
	config?: HanaCharConfig<T | Writable<T>>,
): HanaCharBuilder<Writable<T>>;
export function char<
	U extends string,
	T extends Readonly<[U, ...U[]]>,
>(
	name: string,
	config?: HanaCharConfig<T | Writable<T>>,
): HanaCharBuilder<Writable<T>>;
export function char(a?: string | HanaCharConfig, b: HanaCharConfig = {}): any {
	const { name, config } = getColumnNameAndConfig<HanaCharConfig>(a, b);
	return new HanaCharBuilder(name, config as any);
}
