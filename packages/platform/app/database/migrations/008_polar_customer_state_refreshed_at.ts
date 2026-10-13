import { type Kysely, sql } from "kysely"

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("polar_customer_state")
		.dropColumn("event_timestamp")
		.addColumn("refreshed_at", "timestamptz", (column) =>
			column.notNull().defaultTo(sql`now()`),
		)
		.execute()
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("polar_customer_state")
		.dropColumn("refreshed_at")
		.addColumn("event_timestamp", "timestamptz")
		.execute()
}
