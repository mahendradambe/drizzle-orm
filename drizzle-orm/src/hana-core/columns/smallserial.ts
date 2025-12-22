import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaSmallSerialBuilder extends HanaColumnBuilder<{
	dataType: 'number int16';
	data: number;
	driverParam: number;
	notNull: true;
	hasDefault: true;
}> {
	static override readonly [entityKind]: string = 'HanaSmallSerialBuilder';

	constructor(name: string) {
		super(name, 'number int16', 'HanaSmallSerial');
		this.config.hasDefault = true;
		this.config.notNull = true;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaSmallSerial(
			table,
			this.config as any,
		);
	}
}

export class HanaSmallSerial<T extends ColumnBaseConfig<'number int16'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaSmallSerial';

	getSQLType(): string {
		return 'smallserial';
	}
}

export function smallserial(name?: string): HanaSmallSerialBuilder {
	return new HanaSmallSerialBuilder(name ?? '');
}
