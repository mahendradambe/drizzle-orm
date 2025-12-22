import { entityKind } from '~/entity.ts';
import type { HanaDialect } from '~/hana-core/dialect.ts';
import type {
	HanaPreparedQuery,
	HanaQueryResultHKT,
	HanaQueryResultKind,
	HanaSession,
	PreparedQueryConfig,
} from '~/hana-core/session.ts';
import type { HanaMaterializedView } from '~/hana-core/view.ts';
import { QueryPromise } from '~/query-promise.ts';
import type { RunnableQuery } from '~/runnable-query.ts';
import type { Query, SQL, SQLWrapper } from '~/sql/sql.ts';
import { tracer } from '~/tracing.ts';

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HanaRefreshMaterializedView<TQueryResult extends HanaQueryResultHKT>
	extends
		QueryPromise<HanaQueryResultKind<TQueryResult, never>>,
		RunnableQuery<HanaQueryResultKind<TQueryResult, never>, 'hana'>,
		SQLWrapper
{
	readonly _: {
		readonly dialect: 'hana';
		readonly result: HanaQueryResultKind<TQueryResult, never>;
	};
}

export class HanaRefreshMaterializedView<TQueryResult extends HanaQueryResultHKT>
	extends QueryPromise<HanaQueryResultKind<TQueryResult, never>>
	implements RunnableQuery<HanaQueryResultKind<TQueryResult, never>, 'hana'>, SQLWrapper
{
	static override readonly [entityKind]: string = 'HanaRefreshMaterializedView';

	private config: {
		view: HanaMaterializedView;
		concurrently?: boolean;
		withNoData?: boolean;
	};

	constructor(
		view: HanaMaterializedView,
		private session: HanaSession,
		private dialect: HanaDialect,
	) {
		super();
		this.config = { view };
	}

	concurrently(): this {
		if (this.config.withNoData !== undefined) {
			throw new Error('Cannot use concurrently and withNoData together');
		}
		this.config.concurrently = true;
		return this;
	}

	withNoData(): this {
		if (this.config.concurrently !== undefined) {
			throw new Error('Cannot use concurrently and withNoData together');
		}
		this.config.withNoData = true;
		return this;
	}

	/** @internal */
	getSQL(): SQL {
		return this.dialect.buildRefreshMaterializedViewQuery(this.config);
	}

	toSQL(): Query {
		const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}

	/** @internal */
	_prepare(): HanaPreparedQuery<
		PreparedQueryConfig & {
			execute: HanaQueryResultKind<TQueryResult, never>;
		}
	> {
		return tracer.startActiveSpan('drizzle.prepareQuery', () => {
			return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), undefined, true);
		});
	}

	prepare(): HanaPreparedQuery<
		PreparedQueryConfig & {
			execute: HanaQueryResultKind<TQueryResult, never>;
		}
	> {
		return this._prepare();
	}

	execute: ReturnType<this['prepare']>['execute'] = (placeholderValues) => {
		return tracer.startActiveSpan('drizzle.operation', () => {
			return this._prepare().execute(placeholderValues);
		});
	};
}
