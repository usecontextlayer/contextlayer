import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("slate_member")
		.addColumn("slate_id", "uuid", (column) =>
			column.notNull().references("slate.id").onDelete("cascade"),
		)
		.addColumn("user_id", "text", (column) => column.notNull())
		.addPrimaryKeyConstraint("slate_member_pkey", ["slate_id", "user_id"])
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("slate_member").execute()
}
