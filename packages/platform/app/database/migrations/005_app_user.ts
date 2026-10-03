import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("app_user")
		.addColumn("app_id", "uuid", (column) =>
			column.notNull().references("app.id").onDelete("cascade"),
		)
		.addColumn("user_id", "text", (column) => column.notNull())
		.addPrimaryKeyConstraint("app_user_pkey", ["app_id", "user_id"])
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("app_user").execute()
}
