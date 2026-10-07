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
			return { rows: method === "get" ? (result.rows[0] ?? []) : result.rows }
		},
		{ schema },
	)
}
