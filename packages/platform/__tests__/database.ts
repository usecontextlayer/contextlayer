import { provisionEphemeralDatabases } from "@usecontextlayer/dev-env/database"
import { readDevEnv } from "@usecontextlayer/dev-env/env"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
// biome-ignore lint/style/noRestrictedImports: shared Worker fixtures live outside the package
import { test as base } from "../../../vitest.workers.ts"

export const test = base
	.extend("addresses", { scope: "file" }, () => readDevEnv())
	.extend("databases", { scope: "file" }, async ({ addresses }, { onCleanup }) => {
		const databases = await provisionEphemeralDatabases(
			addresses.CTX_PLATFORM_DATABASE_URL,
			{ migrators: { ctx_platform_test: migrateToLatest } },
		)
		onCleanup(() => databases.dropAll())
		return databases
	})
	.extend("db", { scope: "file" }, async ({ databases }, { onCleanup }) => {
		const db = createPlatformDb(databases.urls.ctx_platform_test)
		onCleanup(() => db.destroy())
		return db
	})
