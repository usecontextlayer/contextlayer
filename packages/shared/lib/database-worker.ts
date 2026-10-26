import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { databaseQuerySchema, databaseResultSchema, type SqlValue } from "@/lib/databases"
import type { LocalResourceConfiguration } from "@/lib/slate-resources"

export class SlateDatabase extends DurableObject {
	async query(sql: string, params: SqlValue[] = []) {
		const cursor = this.ctx.storage.sql.exec(sql, ...params)
		const rows = cursor.toArray()
		const mutation =
			cursor.columnNames.length === 0
				? this.ctx.storage.sql
						.exec("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid")
						.one()
				: {}
		return databaseResultSchema.parse({
			...mutation,
			columns: cursor.columnNames,
			rows,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
		})
	}
}

export class LocalDatabases extends WorkerEntrypoint<
	{ DATABASE_STORAGE: DurableObjectNamespace<SlateDatabase> },
	{ databases: LocalResourceConfiguration["databases"] }
> {
	async fetch(request: Request) {
		const { slug, sql, params } = databaseQuerySchema.parse(await request.json())
		return Response.json(await this.query(slug, sql, params))
	}

	async query(slug: string, sql: string, params: SqlValue[] = []) {
		const database = this.ctx.props.databases[slug]
		if (!database) throw new Error(`No local database requirement for "${slug}"`)
		return this.env.DATABASE_STORAGE.getByName(database.instance_name).query(sql, params)
	}
}
