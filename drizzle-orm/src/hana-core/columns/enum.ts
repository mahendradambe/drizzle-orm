import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import type { NonArray, Writable } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

// Enum as ts enum
export interface HanaEnumObject<TValues extends object> {
	(name?: string): HanaEnumObjectColumnBuilder<TValues>;

	readonly enumName: string;
	readonly enumValues: string[];
	readonly schema: string | undefined;
	/** @internal */
	[isHanaEnumSym]: true;
}

export class HanaEnumObjectColumnBuilder<
	TValues extends object,
> extends HanaColumnBuilder<{
	dataType: 'string enum';
	data: TValues[keyof TValues];
	enumValues: string[];
	driverParam: string;
}, { enum: HanaEnumObject<any> }> {
	static override readonly [entityKind]: string = 'HanaEnumObjectColumnBuilder';

	constructor(name: string, enumInstance: HanaEnumObject<any>) {
		super(name, 'string enum', 'HanaEnumObjectColumn');
		this.config.enum = enumInstance;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaEnumObjectColumn(
			table,
			this.config as any,
		);
	}
}

export class HanaEnumObjectColumn<T extends ColumnBaseConfig<'string enum'> & { enumValues: object }>
	extends HanaColumn<T, { enum: HanaEnumObject<object> }>
{
	static override readonly [entityKind]: string = 'HanaEnumObjectColumn';

	readonly enum;
	override readonly enumValues = this.config.enum.enumValues;

	constructor(
		table: HanaTable<any>,
		config: HanaEnumObjectColumnBuilder<T['enumValues']>['config'],
	) {
		super(table, config);
		this.enum = config.enum;
	}

	getSQLType(): string {
		return this.enum.enumName;
	}
}

// Enum as string union

const isHanaEnumSym = Symbol.for('drizzle:isHanaEnum');
export interface HanaEnum<TValues extends [string, ...string[]]> {
	(name?: string): HanaEnumColumnBuilder<TValues>;

	readonly enumName: string;
	readonly enumValues: TValues;
	readonly schema: string | undefined;
	/** @internal */
	[isHanaEnumSym]: true;
}

export function isHanaEnum(obj: unknown): obj is HanaEnum<[string, ...string[]]> {
	return !!obj && typeof obj === 'function' && isHanaEnumSym in obj && obj[isHanaEnumSym] === true;
}

export class HanaEnumColumnBuilder<
	TValues extends [string, ...string[]],
> extends HanaColumnBuilder<{
	dataType: 'string enum';
	data: TValues[number];
	enumValues: TValues;
	driverParam: string;
}, { enum: HanaEnum<TValues> }> {
	static override readonly [entityKind]: string = 'HanaEnumColumnBuilder';

	constructor(name: string, enumInstance: HanaEnum<TValues>) {
		super(name, 'string enum', 'HanaEnumColumn');
		this.config.enum = enumInstance;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaEnumColumn(
			table,
			this.config as any,
		);
	}
}

export class HanaEnumColumn<T extends ColumnBaseConfig<'string enum'> & { enumValues: [string, ...string[]] }>
	extends HanaColumn<T, { enum: HanaEnum<T['enumValues']> }>
{
	static override readonly [entityKind]: string = 'HanaEnumColumn';

	readonly enum = this.config.enum;
	override readonly enumValues = this.config.enum.enumValues;

	constructor(
		table: HanaTable<any>,
		config: HanaEnumColumnBuilder<T['enumValues']>['config'],
	) {
		super(table, config);
		this.enum = config.enum;
	}

	getSQLType(): string {
		return this.enum.enumName;
	}
}

export function hanaEnum<U extends string, T extends Readonly<[U, ...U[]]>>(
	enumName: string,
	values: T | Writable<T>,
): HanaEnum<Writable<T>>;

export function hanaEnum<E extends Record<string, string>>(
	enumName: string,
	enumObj: NonArray<E>,
): HanaEnumObject<E>;

export function hanaEnum(
	enumName: any,
	input: any,
): any {
	return Array.isArray(input)
		? hanaEnumWithSchema(enumName, [...input] as [string, ...string[]], undefined)
		: hanaEnumObjectWithSchema(enumName, input, undefined);
}

/** @internal */
export function hanaEnumWithSchema<U extends string, T extends Readonly<[U, ...U[]]>>(
	enumName: string,
	values: T | Writable<T>,
	schema?: string,
): HanaEnum<Writable<T>> {
	const enumInstance: HanaEnum<Writable<T>> = Object.assign(
		(name?: string): HanaEnumColumnBuilder<Writable<T>> => new HanaEnumColumnBuilder(name ?? '', enumInstance),
		{
			enumName,
			enumValues: values,
			schema,
			[isHanaEnumSym]: true,
		} as const,
	);

	return enumInstance;
}

/** @internal */
export function hanaEnumObjectWithSchema<T extends object>(
	enumName: string,
	values: T,
	schema?: string,
): HanaEnumObject<T> {
	const enumInstance: HanaEnumObject<T> = Object.assign(
		(name?: string): HanaEnumObjectColumnBuilder<T> => new HanaEnumObjectColumnBuilder(name ?? '', enumInstance),
		{
			enumName,
			enumValues: Object.values(values),
			schema,
			[isHanaEnumSym]: true,
		} as const,
	);

	return enumInstance;
}
