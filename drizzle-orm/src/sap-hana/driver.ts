import { type Connection, type ConnectionOptions, createConnection } from '@sap/hana-client';
import * as V1 from '~/_relations.ts';
import type { Cache } from '~/cache/core/cache.ts';
import { entityKind } from '~/entity.ts';
import { HanaDatabase } from '~/hana-core/db.ts';
import { HanaDialect } from '~/hana-core/dialect.ts';
import type { Logger } from '~/logger.ts';
import { DefaultLogger } from '~/logger.ts';
import type { AnyRelations, EmptyRelations } from '~/relations.ts';
import type { DrizzleConfig } from '~/utils.ts';
import type { SapHanaClient, SapHanaQueryResultHKT } from './session.ts';
import { SapHanaSession } from './session.ts';

export interface HanaDriverOptions {
	logger?: Logger;
	cache?: Cache;
}

export class SapHanaDriver {
	static readonly [entityKind]: string = 'SapHanaDriver';

	constructor(
		private client: SapHanaClient,
		private dialect: HanaDialect,
		private options: HanaDriverOptions = {},
	) {
	}

	createSession(
		relations: AnyRelations,
		schema: V1.RelationalSchemaConfig<V1.TablesRelationalConfig> | undefined,
	): SapHanaSession<Record<string, unknown>, AnyRelations, V1.TablesRelationalConfig> {
		return new SapHanaSession(this.client, this.dialect, relations, schema, {
			logger: this.options.logger,
			cache: this.options.cache,
		});
	}
}

export class SapHanaDatabase<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
> extends HanaDatabase<SapHanaQueryResultHKT, TSchema, TRelations> {
	static override readonly [entityKind]: string = 'SapHanaDatabase';
}

function construct<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
	TClient extends SapHanaClient = SapHanaClient,
>(
	client: TClient,
	config: DrizzleConfig<TSchema, TRelations> = {},
): SapHanaDatabase<TSchema, TRelations> & {
	$client: TClient;
} {
	const dialect = new HanaDialect({ casing: config.casing });
	let logger;
	if (config.logger === true) {
		logger = new DefaultLogger();
	} else if (config.logger !== false) {
		logger = config.logger;
	}

	let schema: V1.RelationalSchemaConfig<V1.TablesRelationalConfig> | undefined;
	if (config.schema) {
		const tablesConfig = V1.extractTablesRelationalConfig(
			config.schema,
			V1.createTableRelationsHelpers,
		);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap,
		};
	}

	const relations = config.relations ?? {} as TRelations;
	const driver = new SapHanaDriver(client, dialect, { logger, cache: config.cache });
	const session = driver.createSession(relations, schema);
	const db = new SapHanaDatabase(
		dialect,
		session,
		relations,
		schema as V1.RelationalSchemaConfig<any>,
	) as SapHanaDatabase<TSchema>;
	(<any> db).$client = client;
	(<any> db).$cache = config.cache;
	if ((<any> db).$cache) {
		(<any> db).$cache['invalidate'] = config.cache?.onMutate;
	}

	return db as any;
}

export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TRelations extends AnyRelations = EmptyRelations,
	TClient extends SapHanaClient = Connection,
>(
	params:
		& DrizzleConfig<TSchema, TRelations>
		& ({
			client: TClient;
		} | {
			connection: ConnectionOptions;
		}),
): SapHanaDatabase<TSchema, TRelations> & {
	$client: TClient;
} {
	const { client, connection, ...drizzleConfig } = params as
		& DrizzleConfig<TSchema, TRelations>
		& ({
			client: TClient;
		} & {
			connection: ConnectionOptions;
		});

	if (connection) {
		const client = createConnection(connection) as TClient;

		return construct(client, drizzleConfig);
	}

	return construct(client, drizzleConfig);
}

export namespace drizzle {
	export function mock<
		TSchema extends Record<string, unknown> = Record<string, never>,
		TRelations extends AnyRelations = EmptyRelations,
	>(
		config?: DrizzleConfig<TSchema, TRelations>,
	): SapHanaDatabase<TSchema, TRelations> & {
		$client: '$client is not available on drizzle.mock()';
	} {
		return construct({
			exec: () => {
				return Promise.resolve([]);
			},
		} as any, config) as any;
	}
}
