import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("polar_customer_state")
		.addColumn("customer_id", "uuid", (column) => column.primaryKey())
		.addColumn("external_id", "text", (column) => column.unique())
		.addColumn("state", "jsonb", (column) => column.notNull())
		.addColumn("event_timestamp", "timestamptz")
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("polar_customer_state").execute()
}
