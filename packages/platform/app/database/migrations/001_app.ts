import { type Kysely, sql } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("app")
		.addColumn("id", "uuid", (column) =>
			column.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("public_hostname", "text", (column) => column.notNull())
		.execute()
	await db.schema
		.createIndex("app_public_hostname_unique")
		.on("app")
		.column("public_hostname")
		.unique()
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("app").execute()
}
