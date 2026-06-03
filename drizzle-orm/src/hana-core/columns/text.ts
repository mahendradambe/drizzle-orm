import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaTextBuilder extends HanaColumnBuilder<{
	dataType: 'string text';
	data: string;
	driverParam: string;
}> {
	static override readonly [entityKind]: string = 'HanaTextBuilder';

	constructor(name: string) {
		super(name, 'string text', 'HanaText');
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaText(table, this.config);
	}
}

export class HanaText<T extends ColumnBaseConfig<'string text'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaText';

	getSQLType(): string {
		return 'text';
	}
}

/** HANA TEXT (fulltext-indexable Unicode LOB; semantically distinct from pg-core TEXT which is variable-length VARCHAR). */
export function text(name?: string): HanaTextBuilder {
	return new HanaTextBuilder(name ?? '');
}
