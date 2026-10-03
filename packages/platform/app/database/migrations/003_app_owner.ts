import { type Kysely, sql } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("app")
		.addColumn("owner_user_id", "text")
		.addColumn("owner_organization_id", "text")
		.execute()
	await db.schema
		.alterTable("app")
		.addCheckConstraint(
			"app_exactly_one_owner",
			sql`(owner_user_id IS NOT NULL) <> (owner_organization_id IS NOT NULL)`,
		)
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.alterTable("app").dropConstraint("app_exactly_one_owner").execute()
	await db.schema
		.alterTable("app")
		.dropColumn("owner_user_id")
		.dropColumn("owner_organization_id")
		.execute()
}
