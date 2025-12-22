import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaBooleanBuilder extends HanaColumnBuilder<{
	dataType: 'boolean';
	data: boolean;
	driverParam: boolean;
}> {
	static override readonly [entityKind]: string = 'HanaBooleanBuilder';

	constructor(name: string) {
		super(name, 'boolean', 'HanaBoolean');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBoolean(table, this.config as any);
	}
}

export class HanaBoolean<T extends ColumnBaseConfig<'boolean'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBoolean';

	getSQLType(): string {
		return 'boolean';
	}
}

export function boolean(name?: string): HanaBooleanBuilder {
	return new HanaBooleanBuilder(name ?? '');
}
