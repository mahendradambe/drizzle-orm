import { entityKind, is } from '~/entity.ts';
import type { HanaDialectConfig } from '~/hana-core/dialect.ts';
import { HanaDialect } from '~/hana-core/dialect.ts';
import type { TypedQueryBuilder } from '~/query-builders/query-builder.ts';
import { SelectionProxyHandler } from '~/selection-proxy.ts';
import type { ColumnsSelection, SQL, SQLWrapper } from '~/sql/sql.ts';
import { WithSubquery } from '~/subquery.ts';
import type { HanaColumn } from '../columns/index.ts';
import type { WithBuilder } from '../subquery.ts';
import { HanaSelectBuilder } from './select.ts';
import type { SelectedFields } from './select.types.ts';

export class QueryBuilder {
	static readonly [entityKind]: string = 'HanaQueryBuilder';

	private dialect: HanaDialect | undefined;
	private dialectConfig: HanaDialectConfig | undefined;

	constructor(dialect?: HanaDialect | HanaDialectConfig) {
		this.dialect = is(dialect, HanaDialect) ? dialect : undefined;
		this.dialectConfig = is(dialect, HanaDialect) ? undefined : dialect;
	}

	$with: WithBuilder = (alias: string, selection?: ColumnsSelection) => {
		const queryBuilder = this;
		const as = (
			qb:
				| TypedQueryBuilder<ColumnsSelection | undefined>
				| SQL
				| ((qb: QueryBuilder) => TypedQueryBuilder<ColumnsSelection | undefined> | SQL),
		) => {
			if (typeof qb === 'function') {
				qb = qb(queryBuilder);
			}

			return new Proxy(
				new WithSubquery(
					qb.getSQL(),
					selection ?? ('getSelectedFields' in qb ? qb.getSelectedFields() ?? {} : {}) as SelectedFields,
					alias,
					true,
				),
				new SelectionProxyHandler({ alias, sqlAliasedBehavior: 'alias', sqlBehavior: 'error' }),
			) as any;
		};
		return { as };
	};

	with(...queries: WithSubquery[]) {
		const self = this;

		function select(): HanaSelectBuilder<undefined, 'qb'>;
		function select<TSelection extends SelectedFields>(fields: TSelection): HanaSelectBuilder<TSelection, 'qb'>;
		function select<TSelection extends SelectedFields>(
			fields?: TSelection,
		): HanaSelectBuilder<TSelection | undefined, 'qb'> {
			return new HanaSelectBuilder({
				fields: fields ?? undefined,
				session: undefined,
				dialect: self.getDialect(),
				withList: queries,
			});
		}

		function selectDistinct(): HanaSelectBuilder<undefined, 'qb'>;
		function selectDistinct<TSelection extends SelectedFields>(fields: TSelection): HanaSelectBuilder<TSelection, 'qb'>;
		function selectDistinct<TSelection extends SelectedFields>(
			fields?: TSelection,
		): HanaSelectBuilder<TSelection | undefined, 'qb'> {
			return new HanaSelectBuilder({
				fields: fields ?? undefined,
				session: undefined,
				dialect: self.getDialect(),
				distinct: true,
			});
		}

		function selectDistinctOn(on: (HanaColumn | SQLWrapper)[]): HanaSelectBuilder<undefined, 'qb'>;
		function selectDistinctOn<TSelection extends SelectedFields>(
			on: (HanaColumn | SQLWrapper)[],
			fields: TSelection,
		): HanaSelectBuilder<TSelection, 'qb'>;
		function selectDistinctOn<TSelection extends SelectedFields>(
			on: (HanaColumn | SQLWrapper)[],
			fields?: TSelection,
		): HanaSelectBuilder<TSelection | undefined, 'qb'> {
			return new HanaSelectBuilder({
				fields: fields ?? undefined,
				session: undefined,
				dialect: self.getDialect(),
				distinct: { on },
			});
		}

		return { select, selectDistinct, selectDistinctOn };
	}

	select(): HanaSelectBuilder<undefined, 'qb'>;
	select<TSelection extends SelectedFields>(fields: TSelection): HanaSelectBuilder<TSelection, 'qb'>;
	select<TSelection extends SelectedFields>(fields?: TSelection): HanaSelectBuilder<TSelection | undefined, 'qb'> {
		return new HanaSelectBuilder({
			fields: fields ?? undefined,
			session: undefined,
			dialect: this.getDialect(),
		});
	}

	selectDistinct(): HanaSelectBuilder<undefined>;
	selectDistinct<TSelection extends SelectedFields>(fields: TSelection): HanaSelectBuilder<TSelection>;
	selectDistinct<TSelection extends SelectedFields>(fields?: TSelection): HanaSelectBuilder<TSelection | undefined> {
		return new HanaSelectBuilder({
			fields: fields ?? undefined,
			session: undefined,
			dialect: this.getDialect(),
			distinct: true,
		});
	}

	selectDistinctOn(on: (HanaColumn | SQLWrapper)[]): HanaSelectBuilder<undefined>;
	selectDistinctOn<TSelection extends SelectedFields>(
		on: (HanaColumn | SQLWrapper)[],
		fields: TSelection,
	): HanaSelectBuilder<TSelection>;
	selectDistinctOn<TSelection extends SelectedFields>(
		on: (HanaColumn | SQLWrapper)[],
		fields?: TSelection,
	): HanaSelectBuilder<TSelection | undefined> {
		return new HanaSelectBuilder({
			fields: fields ?? undefined,
			session: undefined,
			dialect: this.getDialect(),
			distinct: { on },
		});
	}

	// Lazy load dialect to avoid circular dependency
	private getDialect() {
		if (!this.dialect) {
			this.dialect = new HanaDialect(this.dialectConfig);
		}

		return this.dialect;
	}
}
