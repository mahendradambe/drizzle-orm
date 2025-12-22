import type { ColumnBaseConfig } from '~/column.ts';
import { entityKind } from '~/entity.ts';
import type { HanaTable } from '~/hana-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import { HanaColumn, HanaColumnBuilder } from './common.ts';
import type { Precision } from './timestamp.ts';

export class HanaIntervalBuilder extends HanaColumnBuilder<{
	dataType: 'string interval';
	data: string;
	driverParam: string;
}, { intervalConfig: IntervalConfig }> {
	static override readonly [entityKind]: string = 'HanaIntervalBuilder';

	constructor(
		name: string,
		intervalConfig: IntervalConfig,
	) {
		super(name, 'string interval', 'HanaInterval');
		this.config.intervalConfig = intervalConfig;
	}

	/** @internal */
	override build(table: HanaTable<any>) {
		return new HanaInterval(table, this.config as any);
	}
}

export class HanaInterval<T extends ColumnBaseConfig<'string interval'>>
	extends HanaColumn<T, { intervalConfig: IntervalConfig }>
{
	static override readonly [entityKind]: string = 'HanaInterval';

	readonly fields: IntervalConfig['fields'] = this.config.intervalConfig.fields;
	readonly precision: IntervalConfig['precision'] = this.config.intervalConfig.precision;

	getSQLType(): string {
		const fields = this.fields ? ` ${this.fields}` : '';
		const precision = this.precision ? `(${this.precision})` : '';
		return `interval${fields}${precision}`;
	}
}

export interface IntervalConfig {
	fields?:
		| 'year'
		| 'month'
		| 'day'
		| 'hour'
		| 'minute'
		| 'second'
		| 'year to month'
		| 'day to hour'
		| 'day to minute'
		| 'day to second'
		| 'hour to minute'
		| 'hour to second'
		| 'minute to second';
	precision?: Precision;
}

export function interval(
	config?: IntervalConfig,
): HanaIntervalBuilder;
export function interval(
	name: string,
	config?: IntervalConfig,
): HanaIntervalBuilder;
export function interval(a?: string | IntervalConfig, b: IntervalConfig = {}) {
	const { name, config } = getColumnNameAndConfig<IntervalConfig>(a, b);
	return new HanaIntervalBuilder(name, config);
}
