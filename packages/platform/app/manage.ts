import { join } from "node:path"
import { runManage } from "@usecontextlayer/db-infra"
import { parseDatabaseEnv } from "@/env"

await runManage({
	databaseDir: join(import.meta.dirname, "database"),
	databaseUrl: parseDatabaseEnv(process.env).CTX_PLATFORM_DATABASE_URL,
})
