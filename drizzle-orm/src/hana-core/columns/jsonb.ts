import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaJsonbBuilder extends HanaColumnBuilder<{
	dataType: 'object json';
	data: unknown;
	driverParam: unknown;
}> {
	static override readonly [entityKind]: string = 'HanaJsonbBuilder';

	constructor(name: string) {
		super(name, 'object json', 'HanaJsonb');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaJsonb(table, this.config as any);
	}
}

export class HanaJsonb<T extends ColumnBaseConfig<'object json'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaJsonb';

	constructor(table: HanaTable<any>, config: HanaJsonbBuilder['config']) {
		super(table, config);
	}

	getSQLType(): string {
		return 'jsonb';
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

export function jsonb(name?: string): HanaJsonbBuilder {
	return new HanaJsonbBuilder(name ?? '');
}
