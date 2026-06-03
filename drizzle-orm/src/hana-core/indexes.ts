import { entityKind, is } from '~/entity.ts';
import { SQL } from '~/sql/sql.ts';
import type { HanaColumn } from './columns/index.ts';
import { ExtraConfigColumn, IndexedColumn } from './columns/index.ts';
import type { HanaTable } from './table.ts';

interface IndexConfig {
	name?: string;

	columns: Partial<IndexedColumn | SQL>[];

	/**
	 * If true, the index will be created as `create unique index` instead of `create index`.
	 */
	unique: boolean;

	/**
	 * If true, the index will be created as `create index concurrently` instead of `create index`.
	 */
	concurrently?: boolean;

	/**
	 * If true, the index will be created as `create index ... on only <table>` instead of `create index ... on <table>`.
	 */
	only: boolean;

	/**
	 * Condition for partial index.
	 */
	where?: SQL;

	/**
	 * The optional WITH clause specifies storage parameters for the index
	 */
	with?: Record<string, any>;

	/**
	 * The optional WITH clause method for the index
	 */
	method?: 'btree' | string;
}

export type IndexColumn = HanaColumn;

export type HanaIndexMethod = 'btree' | (string & {});

/**
 * Operator class identifier accepted by `ExtraConfigColumn.op()` for HANA
 * indexes. Standard B-tree / CPB-tree / inverted-value indexes derive their
 * comparison ordering from the column's native type; an explicit operator
 * class is required only for specialized index families (vector / spatial /
 * text-search) that ship with the `hana_vector` extension or comparable
 * HANA add-ons.
 *
 * When the `hana_vector` extension is installed, the recognised tokens are
 * the eight literals enumerated below. Any other string is accepted at the
 * type-system layer via the trailing string escape-hatch and passed
 * verbatim to HANA; the dialect performs no SQL-level validation of the
 * token.
 *
 * TODO(citation): link SAP HANA Cloud `hana_vector` extension reference
 * once the public-doc URL is pinned; gate at upstream-PR submission via
 * `grep -rn 'TODO(citation):' drizzle-orm/src/hana-core/` returning 0.
 */
export type HanaIndexOpClass =
	| 'vector_l2_ops'
	| 'vector_ip_ops'
	| 'vector_cosine_ops'
	| 'vector_l1_ops'
	| 'bit_hamming_ops'
	| 'bit_jaccard_ops'
	| 'halfvec_l2_ops'
	| 'sparsevec_l2_op'
	| (string & {});

export class IndexBuilderOn {
	static readonly [entityKind]: string = 'HanaIndexBuilderOn';

	constructor(private unique: boolean, private name?: string) {}

	on(
		...columns: [Partial<ExtraConfigColumn> | SQL | HanaColumn, ...(Partial<ExtraConfigColumn | SQL | HanaColumn>)[]]
	): IndexBuilder {
		return new IndexBuilder(
			columns.map((it) => {
				if (is(it, SQL)) {
					return it;
				}

				if (is(it, ExtraConfigColumn)) {
					const clonedIndexedColumn = new IndexedColumn(
						it.name,
						!!it.keyAsName,
						it.columnType!,
						it.indexConfig!,
					);
					it.indexConfig = JSON.parse(JSON.stringify(it.defaultConfig));
					return clonedIndexedColumn;
				}

				it = it as HanaColumn;

				return new IndexedColumn(
					it.name,
					!!it.keyAsName,
					it.columnType!,
					{},
				);
			}),
			this.unique,
			false,
			this.name,
		);
	}

	onOnly(
		...columns: [Partial<ExtraConfigColumn | SQL | HanaColumn>, ...Partial<ExtraConfigColumn | SQL | HanaColumn>[]]
	): IndexBuilder {
		return new IndexBuilder(
			columns.map((it) => {
				if (is(it, SQL)) {
					return it;
				}

				if (is(it, ExtraConfigColumn)) {
					const clonedIndexedColumn = new IndexedColumn(
						it.name,
						!!it.keyAsName,
						it.columnType!,
						it.indexConfig!,
					);
					it.indexConfig = JSON.parse(JSON.stringify(it.defaultConfig));
					return clonedIndexedColumn;
				}

				it = it as HanaColumn;

				return new IndexedColumn(
					it.name,
					!!it.keyAsName,
					it.columnType!,
					{},
				);
			}),
			this.unique,
			true,
			this.name,
		);
	}

	/**
	 * Specify what index method to use. Choices are `btree`, `hash`, `gist`, `shanaist`, `gin`, `brin`, or user-installed access methods like `bloom`. The default method is `btree.
	 *
	 * If you have the `hana_vector` extension installed in your database, you can use the `hnsw` and `ivfflat` options, which are predefined types.
	 *
	 * **You can always specify any string you want in the method, in case Drizzle doesn't have it natively in its types**
	 *
	 * @param method The name of the index method to be used
	 * @param columns
	 * @returns
	 */
	using(
		method: HanaIndexMethod,
		...columns: [Partial<ExtraConfigColumn | SQL | HanaColumn>, ...Partial<ExtraConfigColumn | SQL | HanaColumn>[]]
	): IndexBuilder {
		return new IndexBuilder(
			columns.map((it) => {
				if (is(it, SQL)) {
					return it;
				}
				if (is(it, ExtraConfigColumn)) {
					const clonedIndexedColumn = new IndexedColumn(
						it.name,
						!!it.keyAsName,
						it.columnType!,
						it.indexConfig!,
					);
					it.indexConfig = JSON.parse(JSON.stringify(it.defaultConfig));
					return clonedIndexedColumn;
				}

				it = it as HanaColumn;

				return new IndexedColumn(
					it.name,
					!!it.keyAsName,
					it.columnType!,
					{},
				);
			}),
			this.unique,
			true,
			this.name,
			method,
		);
	}
}

export interface AnyIndexBuilder {
	build(table: HanaTable): Index;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IndexBuilder extends AnyIndexBuilder {}

export class IndexBuilder implements AnyIndexBuilder {
	static readonly [entityKind]: string = 'HanaIndexBuilder';

	/** @internal */
	config: IndexConfig;

	constructor(
		columns: Partial<IndexedColumn | SQL>[],
		unique: boolean,
		only: boolean,
		name?: string,
		method: string = 'btree',
	) {
		this.config = {
			name,
			columns,
			unique,
			only,
			method,
		};
	}

	concurrently(): this {
		this.config.concurrently = true;
		return this;
	}

	with(obj: Record<string, any>): this {
		this.config.with = obj;
		return this;
	}

	where(condition: SQL): this {
		this.config.where = condition;
		return this;
	}

	/** @internal */
	build(table: HanaTable): Index {
		return new Index(this.config, table);
	}
}

export class Index {
	static readonly [entityKind]: string = 'HanaIndex';

	readonly config: IndexConfig & { table: HanaTable };
	readonly isNameExplicit: boolean;

	constructor(config: IndexConfig, table: HanaTable) {
		this.config = { ...config, table };
		this.isNameExplicit = !!config.name;
	}
}

export type GetColumnsTableName<TColumns> = TColumns extends HanaColumn ? TColumns['_']['name']
	: TColumns extends HanaColumn[] ? TColumns[number]['_']['name']
	: never;

export function index(name?: string): IndexBuilderOn {
	return new IndexBuilderOn(false, name);
}

export function uniqueIndex(name?: string): IndexBuilderOn {
	return new IndexBuilderOn(true, name);
}
