import { bigint } from './bigint.ts';
import { bigserial } from './bigserial.ts';
import { boolean } from './boolean.ts';
import { char } from './char.ts';
import { customType } from './custom.ts';
import { date } from './date.ts';
import { doublePrecision } from './double-precision.ts';
import { integer } from './integer.ts';
import { interval } from './interval.ts';
import { json } from './json.ts';
import { jsonb } from './jsonb.ts';
import { numeric } from './numeric.ts';
import { point } from './point.ts';
import { real } from './real.ts';
import { serial } from './serial.ts';
import { smallint } from './smallint.ts';
import { smallserial } from './smallserial.ts';
import { text } from './text.ts';
import { time } from './time.ts';
import { timestamp } from './timestamp.ts';
import { uuid } from './uuid.ts';
import { varchar } from './varchar.ts';

export function getHanaColumnBuilders() {
	return {
		bigint,
		bigserial,
		boolean,
		char,
		customType,
		date,
		doublePrecision,
		integer,
		interval,
		json,
		jsonb,
		numeric,
		point,
		real,
		serial,
		smallint,
		smallserial,
		text,
		time,
		timestamp,
		uuid,
		varchar,
	};
}

export type HanaColumnsBuilders = ReturnType<typeof getHanaColumnBuilders>;
