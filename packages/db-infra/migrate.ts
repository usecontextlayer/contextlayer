import { promises as fs } from "node:fs"
import * as path from "node:path"
import type { Kysely } from "kysely"
import {
	FileMigrationProvider,
	type MigrationResultSet,
	Migrator,
} from "kysely/migration"
import postgres from "postgres"
import { initKysely } from "@/postgres"

export interface MigrateOptions {
	/** Connection string for the database to migrate. */
	databaseUrl: string
	/**
	 * A directory holding the `migrations/` subdir to run. Schema owners pass
	 * their module's own dir (the sibling-`migrations/` LOCATION CONSTRAINT in
	 * each `database/index.ts`): `database/` in source form, `dist/` in built form.
	 */
	databaseDir: string
}

// The one Migrator construction over a package's `database/migrations/` dir — shared
// by `runManage` (the CLI, which drives up/down/reset too) and `migrateToLatest`.
// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
export function createMigrator(db: Kysely<any>, databaseDir: string): Migrator {
	return new Migrator({
		db,
		provider: new FileMigrationProvider({
			fs,
			migrationFolder: path.join(databaseDir, "migrations"),
			path,
		}),
	})
}

export function assertMigrationSucceeded(result: MigrationResultSet): void {
	if (result.error) {
		throw result.error instanceof Error ? result.error : new Error(String(result.error))
	}
}

/**
 * Programmatic `latest` for one database: own throwaway connection, migrate, close.
 * A failed migration THROWS, matching the `manage` CLI — callers (schema owners'
 * bound `migrateToLatest` exports, test provisioning) must fail loud, not log.
 */
export async function migrateToLatest({
	databaseDir,
	databaseUrl,
}: MigrateOptions): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
	const db = initKysely<any>(postgres(databaseUrl, { max: 1 }))
	try {
		assertMigrationSucceeded(await createMigrator(db, databaseDir).migrateToLatest())
	} finally {
		await db.destroy()
	}
}
