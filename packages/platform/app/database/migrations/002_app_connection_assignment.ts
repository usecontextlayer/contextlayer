import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("app_connection_assignment")
		.addColumn("app_id", "uuid", (column) =>
			column.notNull().references("app.id").onDelete("cascade"),
		)
		.addColumn("user_id", "text", (column) => column.notNull())
		.addColumn("slug", "text", (column) => column.notNull())
		.addColumn("connection_id", "text", (column) => column.notNull())
		.addPrimaryKeyConstraint("app_connection_assignment_pkey", [
			"app_id",
			"user_id",
			"slug",
		])
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("app_connection_assignment").execute()
}
