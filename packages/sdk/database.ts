import { DatabaseDialect } from "@usecontextlayer/shared/database-dialect"
import type { Databases } from "@usecontextlayer/shared/databases"
import { Kysely } from "kysely"

export function database<DB>(databases: Databases, slug: string) {
	return new Kysely<DB>({
		dialect: new DatabaseDialect(async () => ({
			query: (sql, params) => databases.query(slug, sql, params),
		})),
	})
}
