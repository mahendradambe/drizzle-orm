import type { ColumnBuilderBaseConfig, ColumnType } from '~/column-builder.ts';
import { entityKind } from '~/entity.ts';
import { sql } from '~/sql/sql.ts';
import { HanaColumnBuilder } from './common.ts';

export abstract class HanaDateColumnBaseBuilder<
	T extends ColumnBuilderBaseConfig<ColumnType>,
	TRuntimeConfig extends object = object,
> extends HanaColumnBuilder<T, TRuntimeConfig> {
	static override readonly [entityKind]: string = 'HanaDateColumnBaseBuilder';

	defaultNow() {
		return this.default(sql`now()`);
	}
}
