import { migrateToLatest as migrate } from "@usecontextlayer/db-infra"

export function migrateToLatest(databaseUrl: string): Promise<void> {
	return migrate({ databaseDir: import.meta.dirname, databaseUrl })
}
