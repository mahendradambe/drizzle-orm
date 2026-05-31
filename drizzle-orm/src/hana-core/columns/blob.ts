import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaBlobBuilder extends HanaColumnBuilder<{
	dataType: 'buffer blob';
	data: Buffer;
	driverParam: Buffer;
}> {
	static override readonly [entityKind]: string = 'HanaBlobBuilder';

	constructor(name: string) {
		super(name, 'buffer blob', 'HanaBlob');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaBlob(table, this.config);
	}
}

export class HanaBlob<T extends ColumnBaseConfig<'buffer blob'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaBlob';

	getSQLType(): string {
		return 'blob';
	}
}

export function blob(name?: string): HanaBlobBuilder {
	return new HanaBlobBuilder(name ?? '');
}
