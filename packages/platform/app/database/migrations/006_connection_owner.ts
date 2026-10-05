import { type Kysely, sql } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("app_connection_assignment")
		.dropConstraint("app_connection_assignment_pkey")
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.renameColumn("user_id", "owner_id")
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.addColumn("owner_type", "text")
		.execute()
	await db.updateTable("app_connection_assignment").set({ owner_type: "user" }).execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.alterColumn("owner_type", (column) => column.setNotNull())
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.addCheckConstraint(
			"app_connection_assignment_owner_type",
			sql`owner_type IN ('user', 'organization')`,
		)
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.addPrimaryKeyConstraint("app_connection_assignment_pkey", [
			"app_id",
			"owner_type",
			"owner_id",
			"slug",
		])
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	const organization = await db
		.selectFrom("app_connection_assignment")
		.select("owner_id")
		.where("owner_type", "=", "organization")
		.executeTakeFirst()
	if (organization)
		throw new Error("Viewer-only assignments cannot represent organization Owners")
	await db.schema
		.alterTable("app_connection_assignment")
		.dropConstraint("app_connection_assignment_pkey")
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.dropConstraint("app_connection_assignment_owner_type")
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.dropColumn("owner_type")
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.renameColumn("owner_id", "user_id")
		.execute()
	await db.schema
		.alterTable("app_connection_assignment")
		.addPrimaryKeyConstraint("app_connection_assignment_pkey", [
			"app_id",
			"user_id",
			"slug",
		])
		.execute()
}
