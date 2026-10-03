import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema.alterTable("app").addColumn("visibility", "text").execute()
	await db.updateTable("app").set({ visibility: "private" }).execute()
	await db.schema
		.alterTable("app")
		.alterColumn("visibility", (column) => column.setNotNull())
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.alterTable("app").dropColumn("visibility").execute()
}
