import { type Kysely, sql } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("slate_connection_assignment")
		.addColumn("slate_id", "uuid", (column) =>
			column.notNull().references("slate.id").onDelete("cascade"),
		)
		.addColumn("owner_id", "text", (column) => column.notNull())
		.addColumn("slug", "text", (column) => column.notNull())
		.addColumn("connection_id", "text", (column) => column.notNull())
		.addColumn("owner_type", "text", (column) => column.notNull())
		.addCheckConstraint(
			"slate_connection_assignment_owner_type",
			sql`owner_type IN ('personal', 'organization')`,
		)
		.addPrimaryKeyConstraint("slate_connection_assignment_pkey", [
			"slate_id",
			"owner_type",
			"owner_id",
			"slug",
		])
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("slate_connection_assignment").execute()
}
