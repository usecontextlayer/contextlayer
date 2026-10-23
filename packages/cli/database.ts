import {
	DatabaseDialect,
	type DatabaseSession,
} from "@usecontextlayer/shared/database-dialect"
import { databaseResultSchema } from "@usecontextlayer/shared/databases"
import { databaseSlugSchema } from "@usecontextlayer/shared/declaration"
import { z } from "zod"
import { databaseEnv } from "@/env"
import { prepareLocalResourceConfiguration } from "@/resources"
import { getLocalResourcesWorkerName, openLocalDatabases } from "@/vite"

export async function openLocalDatabase(slug: string): Promise<DatabaseSession> {
	const configuration = await prepareLocalResourceConfiguration()
	const connection = await openLocalDatabases(
		getLocalResourcesWorkerName(),
		configuration.databases,
	)
	return {
		destroy: connection.dispose,
		query: (sql, params) => connection.databases.query(slug, sql, params),
	}
}

export function databaseDialect(slug: string) {
	const selected = databaseSlugSchema.parse(slug)
	return new DatabaseDialect(async () => {
		const url = databaseEnv.CTX_DATABASE_URL
		if (!url) return openLocalDatabase(selected)
		return {
			async query(sql, params) {
				const response = await fetch(url, {
					body: JSON.stringify({ params, sql }),
					headers: { "content-type": "application/json" },
					method: "POST",
				})
				const body: unknown = await response.json()
				if (!response.ok)
					throw new Error(z.object({ error: z.string() }).parse(body).error)
				return databaseResultSchema.parse(body)
			},
		}
	})
}
