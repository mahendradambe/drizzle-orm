import { entityKind, is } from '~/entity.ts';

export type HanaSequenceOptions = {
	increment?: number | string;
	minValue?: number | string;
	maxValue?: number | string;
	startWith?: number | string;
	cache?: number | string;
	cycle?: boolean;
};

export class HanaSequence {
	static readonly [entityKind]: string = 'HanaSequence';

	constructor(
		public readonly seqName: string | undefined,
		public readonly seqOptions: HanaSequenceOptions | undefined,
		public readonly schema: string | undefined,
	) {
	}
}

export function hanaSequence(
	name: string,
	options?: HanaSequenceOptions,
): HanaSequence {
	return hanaSequenceWithSchema(name, options, undefined);
}

/** @internal */
export function hanaSequenceWithSchema(
	name: string,
	options?: HanaSequenceOptions,
	schema?: string,
): HanaSequence {
	return new HanaSequence(name, options, schema);
}

export function isHanaSequence(obj: unknown): obj is HanaSequence {
	return is(obj, HanaSequence);
}
