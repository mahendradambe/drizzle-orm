import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { type Equal, getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaPointTupleBuilder extends HanaColumnBuilder<{
	dataType: 'array point';
	data: [number, number];
	driverParam: number | string;
}> {
	static override readonly [entityKind]: string = 'HanaPointTupleBuilder';

	constructor(name: string) {
		super(name, 'array point', 'HanaPointTuple');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaPointTuple(
			table,
			this.config as any,
		);
	}
}

export class HanaPointTuple<T extends ColumnBaseConfig<'array point'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaPointTuple';

	readonly mode = 'tuple';

	getSQLType(): string {
		return 'point';
	}

	override mapFromDriverValue(value: string | { x: number; y: number }): [number, number] {
		if (typeof value === 'string') {
			const [x, y] = value.slice(1, -1).split(',');
			return [Number.parseFloat(x!), Number.parseFloat(y!)];
		}
		return [value.x, value.y];
	}

	override mapToDriverValue(value: [number, number]): string {
		return `(${value[0]},${value[1]})`;
	}
}

export class HanaPointObjectBuilder extends HanaColumnBuilder<{
	dataType: 'object point';
	data: { x: number; y: number };
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaPointObjectBuilder';

	constructor(name: string) {
		super(name, 'object point', 'HanaPointObject');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaPointObject(
			table,
			this.config as any,
		);
	}
}

export class HanaPointObject<T extends ColumnBaseConfig<'object point'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaPointObject';

	readonly mode = 'xy';

	getSQLType(): string {
		return 'point';
	}

	override mapFromDriverValue(value: string | { x: number; y: number }): { x: number; y: number } {
		if (typeof value === 'string') {
			const [x, y] = value.slice(1, -1).split(',');
			return { x: Number.parseFloat(x!), y: Number.parseFloat(y!) };
		}
		return value;
	}

	override mapToDriverValue(value: { x: number; y: number }): string {
		return `(${value.x},${value.y})`;
	}
}

export interface HanaPointConfig<T extends 'tuple' | 'xy' = 'tuple' | 'xy'> {
	mode?: T;
}

export function point<TMode extends HanaPointConfig['mode'] & {}>(
	config?: HanaPointConfig<TMode>,
): Equal<TMode, 'xy'> extends true ? HanaPointObjectBuilder
	: HanaPointTupleBuilder;
export function point<TMode extends HanaPointConfig['mode'] & {}>(
	name: string,
	config?: HanaPointConfig<TMode>,
): Equal<TMode, 'xy'> extends true ? HanaPointObjectBuilder
	: HanaPointTupleBuilder;
export function point(a?: string | HanaPointConfig, b?: HanaPointConfig) {
	const { name, config } = getColumnNameAndConfig<HanaPointConfig>(a, b);
	if (!config?.mode || config.mode === 'tuple') {
		return new HanaPointTupleBuilder(name);
	}
	return new HanaPointObjectBuilder(name);
}
