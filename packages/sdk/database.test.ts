import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expect, test } from "vitest"
import { database } from "@/database"

const updates = sqliteTable("updates", {
	body: text("body").notNull(),
	id: text("id").primaryKey(),
})

test.each([
	{ expected: undefined, name: "undefined for a missing row", rows: [] },
	{
		expected: { body: "Cached update", id: "update-1" },
		name: "the selected record for an existing row",
		rows: [["Cached update", "update-1"]],
	},
])("single-row reads return $name", async ({ expected, rows }) => {
	const client = database(
		{
			query: async () => ({
				columns: ["body", "id"],
				rows,
				rowsRead: rows.length,
				rowsWritten: 0,
			}),
		},
		"updates",
		{ updates },
	)

	expect(await client.select().from(updates).get()).toEqual(expected)
})
