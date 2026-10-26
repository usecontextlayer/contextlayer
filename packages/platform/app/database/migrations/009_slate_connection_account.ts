import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("slate_connection_assignment")
		.renameColumn("connection_id", "account_id")
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("slate_connection_assignment")
		.renameColumn("account_id", "connection_id")
		.execute()
}
