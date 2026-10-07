import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const updates = sqliteTable("updates", {
	body: text("body").notNull(),
	createdAt: integer("created_at").notNull(),
	id: text("id").primaryKey(),
	kind: text("kind").notNull(),
})
