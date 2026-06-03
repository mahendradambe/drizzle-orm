import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';

export class HanaVarbinaryBuilder extends HanaColumnBuilder<
	{
		dataType: 'buffer varbinary';
		data: Buffer;
		driverParam: Buffer;
	},
	{ length: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaVarbinaryBuilder';

	constructor(name: string, config: HanaVarbinaryConfig) {
		super(name, 'buffer varbinary', 'HanaVarbinary');
		this.config.length = config.length;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaVarbinary(table, this.config as any);
	}
}

export class HanaVarbinary<T extends ColumnBaseConfig<'buffer varbinary'>>
	extends HanaColumn<T, { length: number | undefined }>
{
	static override readonly [entityKind]: string = 'HanaVarbinary';

	getSQLType(): string {
		return this.length === undefined ? 'varbinary' : `varbinary(${this.length})`;
	}
}

export interface HanaVarbinaryConfig {
	length?: number;
}

export function varbinary(): HanaVarbinaryBuilder;
export function varbinary(config: HanaVarbinaryConfig): HanaVarbinaryBuilder;
export function varbinary(name: string, config?: HanaVarbinaryConfig): HanaVarbinaryBuilder;
/** HANA VARBINARY (variable-length binary; legal length 1..5000 per HANA SQL Reference). */
export function varbinary(a?: string | HanaVarbinaryConfig, b: HanaVarbinaryConfig = {}): HanaVarbinaryBuilder {
	const { name, config } = getColumnNameAndConfig<HanaVarbinaryConfig>(a, b);
	return new HanaVarbinaryBuilder(name, config);
}
