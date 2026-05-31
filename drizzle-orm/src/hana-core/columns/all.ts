import { bigint } from './bigint.ts';
import { blob } from './blob.ts';
import { boolean } from './boolean.ts';
import { char } from './char.ts';
import { customType } from './custom.ts';
import { date } from './date.ts';
import { double } from './double.ts';
import { integer } from './integer.ts';
import { json } from './json.ts';
import { nclob } from './nclob.ts';
import { numeric, decimal } from './numeric.ts';
import { nvarchar } from './nvarchar.ts';
import { real } from './real.ts';
import { smallint } from './smallint.ts';
import { time } from './time.ts';
import { timestamp } from './timestamp.ts';
import { uuid } from './uuid.ts';
import { varchar } from './varchar.ts';

export function getHanaColumnBuilders() {
	return {
		bigint,
		blob,
		boolean,
		char,
		customType,
		date,
		decimal,
		double,
		integer,
		json,
		nclob,
		numeric,
		nvarchar,
		real,
		smallint,
		time,
		timestamp,
		uuid,
		varchar,
	};
}

export type HanaColumnsBuilders = ReturnType<typeof getHanaColumnBuilders>;
