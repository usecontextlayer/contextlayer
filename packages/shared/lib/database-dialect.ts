import {
	type CompiledQuery,
	type DatabaseConnection,
	type Dialect,
	type Driver,
	type Kysely,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely"
import { type DatabaseResult, type SqlValue, sqlValueSchema } from "@/lib/databases"

export type DatabaseSession = {
	query(sql: string, params: SqlValue[]): Promise<DatabaseResult>
	destroy?(): Promise<void>
}

export class DatabaseDialect implements Dialect {
	constructor(private readonly open: () => Promise<DatabaseSession>) {}

	createAdapter() {
		return new SqliteAdapter()
	}

	createQueryCompiler() {
		return new SqliteQueryCompiler()
	}

	createIntrospector(db: Kysely<unknown>) {
		return new SqliteIntrospector(db)
	}

	createDriver(): Driver {
		const open = this.open
		let session: DatabaseSession
		const connection: DatabaseConnection = {
			async executeQuery<R>({ sql, parameters }: CompiledQuery): Promise<QueryResult<R>> {
				const result = await session.query(
					sql,
					parameters.map((value) => sqlValueSchema.parse(value)),
				)
				return {
					rows: result.rows.map((row) =>
						Object.fromEntries(
							result.columns.map((column, index) => [column, row[index]]),
						),
					) as R[],
				}
			},
			async *streamQuery<R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
				yield await connection.executeQuery<R>(query)
			},
		}
		return {
			async acquireConnection() {
				return connection
			},
			async beginTransaction() {
				throw new Error("Slate databases do not support SQL transactions")
			},
			async commitTransaction() {
				throw new Error("Slate databases do not support SQL transactions")
			},
			async destroy() {
				await session?.destroy?.()
			},
			async init() {
				session = await open()
			},
			async releaseConnection() {},
			async rollbackTransaction() {
				throw new Error("Slate databases do not support SQL transactions")
			},
		}
	}
}
