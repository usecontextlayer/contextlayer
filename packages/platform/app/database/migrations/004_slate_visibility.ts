import type { Kysely } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema.alterTable("slate").addColumn("visibility", "text").execute()
	await db.updateTable("slate").set({ visibility: "private" }).execute()
	await db.schema
		.alterTable("slate")
		.alterColumn("visibility", (column) => column.setNotNull())
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.alterTable("slate").dropColumn("visibility").execute()
}
