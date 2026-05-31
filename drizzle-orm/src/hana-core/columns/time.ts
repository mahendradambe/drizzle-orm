import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn } from './common.ts';
import { HanaDateColumnBaseBuilder } from './date.common.ts';
import type { Precision } from './timestamp.ts';

export class HanaTimeBuilder extends HanaDateColumnBaseBuilder<
	{
		dataType: 'string time';
		data: string;
		driverParam: string;
	},
	{ precision: number | undefined }
> {
	static override readonly [entityKind]: string = 'HanaTimeBuilder';

	constructor(
		name: string,
		readonly precision: number | undefined,
	) {
		super(name, 'string time', 'HanaTime');
		this.config.precision = precision;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaTime(table, this.config as any);
	}
}

export class HanaTime<T extends ColumnBaseConfig<'string time'>> extends HanaColumn<T> {
	static override readonly [entityKind]: string = 'HanaTime';

	readonly precision: number | undefined;

	constructor(table: HanaTable<any>, config: HanaTimeBuilder['config']) {
		super(table, config);
		this.precision = config.precision;
	}

	getSQLType(): string {
		const precision = this.precision === undefined ? '' : `(${this.precision})`;
		return `time${precision}`;
	}
}

export interface TimeConfig {
	precision?: Precision;
}

export function time(config?: TimeConfig): HanaTimeBuilder;
export function time(name: string, config?: TimeConfig): HanaTimeBuilder;
export function time(a?: string | TimeConfig, b: TimeConfig = {}) {
	const { name, config } = getColumnNameAndConfig<TimeConfig>(a, b);
	return new HanaTimeBuilder(name, config.precision);
}
