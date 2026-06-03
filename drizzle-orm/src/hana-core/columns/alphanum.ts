import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaAlphanumBuilder extends HanaColumnBuilder<
	{
		dataType: 'string';
		data: string;
		driverParam: string;
	},
	{ length: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaAlphanumBuilder';

	constructor(name: string, config: HanaAlphanumConfig) {
		super(name, 'string', 'HanaAlphanum');
		this.config.length = config.length;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaAlphanum(table, this.config as any);
	}
}

export class HanaAlphanum<T extends ColumnBaseConfig<'string'>> extends HanaColumn<T, { length: number | undefined }> {
	static override readonly [entityKind]: string = 'HanaAlphanum';

	getSQLType(): string {
		return this.length === undefined ? 'alphanum' : `alphanum(${this.length})`;
	}
}

export interface HanaAlphanumConfig {
	length?: number;
}

export function alphanum(): HanaAlphanumBuilder;
export function alphanum(config: HanaAlphanumConfig): HanaAlphanumBuilder;
export function alphanum(name: string, config?: HanaAlphanumConfig): HanaAlphanumBuilder;
/** HANA ALPHANUM (alphanumeric-restricted text; legal length 1..127 per HANA SQL Reference). */
export function alphanum(a?: string | HanaAlphanumConfig, b: HanaAlphanumConfig = {}): HanaAlphanumBuilder {
	const { name, config } = getColumnNameAndConfig<HanaAlphanumConfig>(a, b);
	return new HanaAlphanumBuilder(name, config);
}
