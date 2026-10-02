import { Kysely } from "kysely"
import { PostgresJSDialect } from "kysely-postgres-js"
import type { Sql } from "postgres"
import { env } from "@/env"

export function initKysely<T>(pg: Sql): Kysely<T> {
	return new Kysely<T>({
		dialect: new PostgresJSDialect({ postgres: pg }),
		log(event) {
			if (event.level === "error" && env.NODE_ENV === "development") {
				console.error("🔴 kysely:", event.query.sql)
			}
		},
	})
}
