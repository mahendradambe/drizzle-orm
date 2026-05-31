import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaNclobBuilder extends HanaColumnBuilder<{
	dataType: 'string nclob';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaNclobBuilder';

	constructor(name: string) {
		super(name, 'string nclob', 'HanaNclob');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaNclob(table, this.config);
	}
}

export class HanaNclob<T extends ColumnBaseConfig<'string nclob'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaNclob';

	getSQLType(): string {
		return 'nclob';
	}
}

export function nclob(name?: string): HanaNclobBuilder {
	return new HanaNclobBuilder(name ?? '');
}
