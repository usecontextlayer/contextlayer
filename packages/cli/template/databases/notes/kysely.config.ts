import { databaseDialect } from "@usecontextlayer/sdk/database"
import { defineConfig } from "kysely-ctl"

export default defineConfig({
	dialect: databaseDialect("notes"),
	migrations: { migrationFolder: "./migrations" },
})
