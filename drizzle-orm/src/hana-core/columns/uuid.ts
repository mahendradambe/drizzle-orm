import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { sql } from '~/sql/sql.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaUUIDBuilder extends HanaColumnBuilder<{
	dataType: 'string uuid';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaUUIDBuilder';

	constructor(name: string) {
		super(name, 'string uuid', 'HanaUUID');
	}

	/**
	 * Adds `default gen_random_uuid()` to the column definition.
	 */
	defaultRandom(): ReturnType<this['default']> {
		return this.default(sql`gen_random_uuid()`) as ReturnType<this['default']>;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaUUID(table, this.config as any);
	}
}

export class HanaUUID<T extends ColumnBaseConfig<'string uuid'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaUUID';

	getSQLType(): string {
		return 'uuid';
	}
}

export function uuid(name?: string): HanaUUIDBuilder {
	return new HanaUUIDBuilder(name ?? '');
}
