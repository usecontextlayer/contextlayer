import { expect, test } from "vitest"
import { database } from "@/database"

type DB = { updates: { body: string; id: string } }

test.each([
	{ expected: undefined, name: "undefined for a missing row", rows: [] },
	{
		expected: { body: "Cached update", id: "update-1" },
		name: "the selected record for an existing row",
		rows: [{ body: "Cached update", id: "update-1" }],
	},
])("single-row reads return $name", async ({ expected, rows }) => {
	const client = database<DB>(
		{
			query: async () => ({
				columns: ["body", "id"],
				rows,
				rowsRead: rows.length,
				rowsWritten: 0,
			}),
		},
		"updates",
	)

	expect(await client.selectFrom("updates").selectAll().executeTakeFirst()).toEqual(
		expected,
	)
})
