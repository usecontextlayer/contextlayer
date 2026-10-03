import { type Kysely, sql } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.createTable("app_folder")
		.addColumn("id", "uuid", (column) =>
			column.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("app_id", "uuid", (column) =>
			column.notNull().references("app.id").onDelete("cascade"),
		)
		.addColumn("user_id", "text")
		.addColumn("slug", "text", (column) => column.notNull())
		.addUniqueConstraint(
			"app_folder_app_id_user_id_slug_key",
			["app_id", "user_id", "slug"],
			(constraint) => constraint.nullsNotDistinct(),
		)
		.addForeignKeyConstraint(
			"app_folder_app_user_fkey",
			["app_id", "user_id"],
			"app_user",
			["app_id", "user_id"],
			(constraint) => constraint.onDelete("cascade"),
		)
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("app_folder").execute()
}
