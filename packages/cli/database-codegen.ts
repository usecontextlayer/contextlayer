import { resolve } from "node:path"
import { DatabaseDialect } from "@usecontextlayer/shared/database-dialect"
import { Kysely } from "kysely"
import { generate, Logger, SqliteDialect } from "kysely-codegen"
import { openLocalDatabase } from "@/database"

export async function generateDatabaseTypes(slug: string) {
	const db = new Kysely({ dialect: new DatabaseDialect(() => openLocalDatabase(slug)) })
	try {
		await generate({
			db,
			dialect: new SqliteDialect(),
			excludePattern: "__miniflare_do_name",
			logger: new Logger(),
			outFile: resolve("databases", slug, "types.ts"),
		})
	} finally {
		await db.destroy()
	}
}
