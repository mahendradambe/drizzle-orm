import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaJsonBuilder extends HanaColumnBuilder<
	{
		dataType: 'object json';
		data: unknown;
		driverParam: unknown;
	}
> {
	static override readonly [entityKind]: string = 'HanaJsonBuilder';

	constructor(name: string) {
		super(name, 'object json', 'HanaJson');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaJson(table, this.config as any);
	}
}

export class HanaJson<T extends ColumnBaseConfig<'object json'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaJson';

	constructor(table: HanaTable<any>, config: HanaJsonBuilder['config']) {
		super(table, config);
	}

	getSQLType(): string {
		return 'nclob';
	}

	override mapToDriverValue(value: T['data']): string {
		return JSON.stringify(value);
	}

	override mapFromDriverValue(value: T['data'] | string): T['data'] {
		if (typeof value === 'string') {
			try {
				return JSON.parse(value);
			} catch {
				return value as T['data'];
			}
		}
		return value;
	}
}

export function json(name?: string): HanaJsonBuilder {
	return new HanaJsonBuilder(name ?? '');
}
