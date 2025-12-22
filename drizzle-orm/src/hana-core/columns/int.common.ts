import type { ColumnBuilderBaseConfig, ColumnType, GeneratedIdentityConfig, IsIdentity } from '~/column-builder.ts';
import { entityKind } from '~/entity.ts';
import type { HanaSequenceOptions } from '../sequence.ts';
import { HanaColumnBuilder } from './common.ts';

export abstract class HanaIntColumnBaseBuilder<
	T extends ColumnBuilderBaseConfig<ColumnType>,
> extends HanaColumnBuilder<
	T,
	{ generatedIdentity: GeneratedIdentityConfig }
> {
	static override readonly [entityKind]: string = 'HanaIntColumnBaseBuilder';

	generatedAlwaysAsIdentity(
		sequence?: HanaSequenceOptions & { name?: string },
	): IsIdentity<this, 'always'> {
		if (sequence) {
			const { name, ...options } = sequence;
			this.config.generatedIdentity = {
				type: 'always',
				sequenceName: name,
				sequenceOptions: options,
			};
		} else {
			this.config.generatedIdentity = {
				type: 'always',
			};
		}

		this.config.hasDefault = true;
		this.config.notNull = true;

		return this as IsIdentity<this, 'always'>;
	}

	generatedByDefaultAsIdentity(
		sequence?: HanaSequenceOptions & { name?: string },
	): IsIdentity<this, 'byDefault'> {
		if (sequence) {
			const { name, ...options } = sequence;
			this.config.generatedIdentity = {
				type: 'byDefault',
				sequenceName: name,
				sequenceOptions: options,
			};
		} else {
			this.config.generatedIdentity = {
				type: 'byDefault',
			};
		}

		this.config.hasDefault = true;
		this.config.notNull = true;

		return this as IsIdentity<this, 'byDefault'>;
	}
}
