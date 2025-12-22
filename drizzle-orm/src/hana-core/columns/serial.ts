import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaSerialBuilder extends HanaColumnBuilder<{
	dataType: 'number int32';
	data: number;
	driverParam: number;

	notNull: true;
	hasDefault: true;
}> {
	static override readonly [entityKind]: string = 'HanaSerialBuilder';

	constructor(name: string) {
		super(name, 'number int32', 'HanaSerial');
		this.config.hasDefault = true;
		this.config.notNull = true;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaSerial(table, this.config as any);
	}
}

export class HanaSerial<T extends ColumnBaseConfig<'number int32'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaSerial';

	getSQLType(): string {
		return 'serial';
	}
}

export function serial(name?: string): HanaSerialBuilder {
	return new HanaSerialBuilder(name ?? '');
}
