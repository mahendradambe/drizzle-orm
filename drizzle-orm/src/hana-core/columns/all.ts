import { alphanum } from './alphanum.ts';
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
import { decimal, numeric } from './numeric.ts';
import { nvarchar } from './nvarchar.ts';
import { real } from './real.ts';
import { seconddate } from './seconddate.ts';
import { shorttext } from './shorttext.ts';
import { smalldecimal } from './smalldecimal.ts';
import { smallint } from './smallint.ts';
import { text } from './text.ts';
import { time } from './time.ts';
import { timestamp } from './timestamp.ts';
import { tinyint } from './tinyint.ts';
import { varbinary } from './varbinary.ts';
import { varchar } from './varchar.ts';

export function getHanaColumnBuilders() {
	return {
		alphanum,
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
		seconddate,
		shorttext,
		smalldecimal,
		smallint,
		text,
		time,
		timestamp,
		tinyint,
		varbinary,
		varchar,
	};
}

export type HanaColumnsBuilders = ReturnType<typeof getHanaColumnBuilders>;
