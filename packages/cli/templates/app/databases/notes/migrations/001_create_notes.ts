import type { Kysely } from "kysely"

export async function up(db: Kysely<unknown>) {
	await db.schema
		.createTable("notes")
		.addColumn("id", "integer", (column) => column.primaryKey().autoIncrement().notNull())
		.addColumn("body", "text", (column) => column.notNull())
		.execute()
}

export async function down(db: Kysely<unknown>) {
	await db.schema.dropTable("notes").execute()
}
