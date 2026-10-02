import { execSync } from "node:child_process"
import * as path from "node:path"
import { Command } from "commander"
import postgres from "postgres"
import { assertMigrationSucceeded, createMigrator } from "@/migrate"
import { initKysely } from "@/postgres"

export interface ManageOptions {
	/** Connection string for the database to manage. */
	databaseUrl: string
	/** The package's `database/` directory (holds `migrations/` and `models/`). */
	databaseDir: string
}

/**
 * The shared `manage` CLI for every v3 database. Each package's `manage.ts` is a
 * thin shim that calls this with its own DSN + database dir. Actions:
 * latest | drop | up | down | downup | codegen | biome.
 *
 * codegen/biome shell out via `pnpm exec`, resolving kanel + the package's
 * `kanel.config.cjs` from the current working directory (the package).
 */
export async function runManage({
	databaseDir,
	databaseUrl,
}: ManageOptions): Promise<void> {
	// A throwaway, untyped Kysely so this runs on a fresh database before any
	// kanel models exist. Bootstrap order: `latest` (migrate) -> `codegen`.
	// biome-ignore lint/suspicious/noExplicitAny: migrations run against an untyped schema
	const db = initKysely<any>(postgres(databaseUrl, { max: 1 }))
	const modelsDir = path.join(databaseDir, "models")

	const migrator = createMigrator(db, databaseDir)

	async function latest(): Promise<void> {
		const result = await migrator.migrateToLatest()
		assertMigrationSucceeded(result)
		console.log(result)
	}

	async function up(): Promise<void> {
		const result = await migrator.migrateUp()
		assertMigrationSucceeded(result)
		console.log(result)
	}

	async function down(): Promise<void> {
		const result = await migrator.migrateDown()
		assertMigrationSucceeded(result)
		console.log(result)
	}

	async function downup(): Promise<void> {
		await down()
		await up()
	}

	async function drop(): Promise<void> {
		await db.schema.dropSchema("public").ifExists().cascade().execute()
		await db.schema.createSchema("public").execute()
	}

	function codegen(): void {
		// kanel v4 has no -d/-o flags: the package's kanel.config.cjs reads this
		// child-only DATABASE_URL and names its own outputPath.
		execSync("pnpm exec kanel", {
			env: { ...process.env, DATABASE_URL: databaseUrl },
			stdio: "inherit",
		})
	}

	function format(): void {
		execSync(`pnpm exec biome check --write ${modelsDir}`, { stdio: "inherit" })
	}

	const ACTIONS: Record<string, () => void | Promise<void>> = {
		biome: format,
		codegen,
		down,
		downup,
		drop,
		latest,
		up,
	}

	const parsed = new Command()
		.option("--no-auto-biome")
		.option("--no-auto-codegen")
		.argument("<action>")
		.parse()

	const action = parsed.args[0]
	if (!action) {
		throw new Error(
			"An action is required (latest | drop | up | down | downup | codegen | biome).",
		)
	}
	const { autoBiome, autoCodegen } = parsed.opts()
	const queue = [action]
	if (autoCodegen) {
		queue.push("codegen")
	}
	if (autoBiome) {
		queue.push("biome")
	}
	const deduped = [...new Set(queue.reverse())].reverse()
	try {
		for (const name of deduped) {
			const fn = ACTIONS[name]
			if (!fn) {
				throw new Error(`Unknown action: ${name}`)
			}
			await fn()
		}
	} finally {
		await db.destroy()
	}
	process.exit(0)
}
