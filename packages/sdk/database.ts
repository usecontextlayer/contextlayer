import type { Databases } from "@usecontextlayer/shared/databases"
import { drizzle } from "drizzle-orm/sqlite-proxy"

export function database<TSchema extends Record<string, unknown>>(
	databases: Databases,
	slug: string,
	schema: TSchema,
) {
	return drizzle(
		async (sql, params, method) => {
			const result = await databases.query(slug, sql, params)
			// sqlite-proxy maps undefined to a missing row despite its array-only callback type.
			return { rows: method === "get" ? (result.rows[0] as unknown[]) : result.rows }
		},
		{ schema },
	)
}
