import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaShortTextBuilder extends HanaColumnBuilder<
	{
		dataType: 'string';
		data: string;
		driverParam: string;
	},
	{ length: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaShortTextBuilder';

	constructor(name: string, config: HanaShortTextConfig) {
		super(name, 'string', 'HanaShortText');
		this.config.length = config.length;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaShortText(table, this.config as any);
	}
}

export class HanaShortText<T extends ColumnBaseConfig<'string'>> extends HanaColumn<T, { length: number | undefined }> {
	static override readonly [entityKind]: string = 'HanaShortText';

	getSQLType(): string {
		return this.length === undefined ? 'shorttext' : `shorttext(${this.length})`;
	}
}

export interface HanaShortTextConfig {
	length?: number;
}

export function shorttext(): HanaShortTextBuilder;
export function shorttext(config: HanaShortTextConfig): HanaShortTextBuilder;
export function shorttext(name: string, config?: HanaShortTextConfig): HanaShortTextBuilder;
/** HANA SHORTTEXT (fulltext-indexable Unicode; legal length 1..5000 per HANA SQL Reference). */
export function shorttext(a?: string | HanaShortTextConfig, b: HanaShortTextConfig = {}): HanaShortTextBuilder {
	const { name, config } = getColumnNameAndConfig<HanaShortTextConfig>(a, b);
	return new HanaShortTextBuilder(name, config);
}
