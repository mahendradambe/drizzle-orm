import { entityKind, is } from '~/entity.ts';
import { SQL, sql, type SQLWrapper } from '~/sql/sql.ts';
import { type hanaSequence, hanaSequenceWithSchema } from './sequence.ts';
import { type HanaTableFn, hanaTableWithSchema } from './table.ts';
import {
	type hanaMaterializedView,
	hanaMaterializedViewWithSchema,
	type hanaView,
	hanaViewWithSchema,
} from './view.ts';

export class HanaSchema<TName extends string = string> implements SQLWrapper {
	static readonly [entityKind]: string = 'HanaSchema';

	isExisting: boolean = false;
	constructor(
		public readonly schemaName: TName,
	) {
		this.table = Object.assign(this.table, {});
	}

	table: HanaTableFn<TName> = ((name, columns, extraConfig) => {
		return hanaTableWithSchema(name, columns, extraConfig, this.schemaName);
	}) as HanaTableFn<TName>;

	view = ((name, columns) => {
		return hanaViewWithSchema(name, columns, this.schemaName);
	}) as typeof hanaView;

	materializedView = ((name, columns) => {
		return hanaMaterializedViewWithSchema(name, columns, this.schemaName);
	}) as typeof hanaMaterializedView;

	sequence: typeof hanaSequence = ((name, options) => {
		return hanaSequenceWithSchema(name, options, this.schemaName);
	});

	getSQL(): SQL {
		return new SQL([sql.identifier(this.schemaName)]);
	}

	shouldOmitSQLParens(): boolean {
		return true;
	}

	existing(): this {
		this.isExisting = true;
		return this;
	}
}

export function isHanaSchema(obj: unknown): obj is HanaSchema {
	return is(obj, HanaSchema);
}

export function hanaSchema<T extends string>(name: T) {
	return new HanaSchema(name);
}
