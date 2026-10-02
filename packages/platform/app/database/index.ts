import { initKysely } from "@usecontextlayer/db-infra"
import postgres from "postgres"
import type Database from "@/database/models/Database"

export function createPlatformDb(databaseUrl: string) {
	return initKysely<Database>(postgres(databaseUrl))
}

export type PlatformDb = ReturnType<typeof createPlatformDb>
