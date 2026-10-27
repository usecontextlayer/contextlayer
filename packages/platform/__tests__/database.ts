import { test as base } from "@tests/workers"
import { provisionEphemeralDatabases } from "@usecontextlayer/dev-env/database"
import { readDevEnv } from "@usecontextlayer/dev-env/env"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"

export const test = base
	.extend("addresses", { scope: "file" }, () => readDevEnv())
	.extend("databases", async ({ addresses }, { onCleanup }) => {
		const databases = await provisionEphemeralDatabases(
			addresses.CTX_PLATFORM_DATABASE_URL,
			{ migrators: { ctx_platform_test: migrateToLatest } },
		)
		onCleanup(() => databases.dropAll())
		return databases
	})
	.extend("db", async ({ databases }, { onCleanup }) => {
		const db = createPlatformDb(databases.urls.ctx_platform_test)
		onCleanup(() => db.destroy())
		return db
	})
