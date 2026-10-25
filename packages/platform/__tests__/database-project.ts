import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function writeDatabase(checkout: string, slug: string) {
	const directory = join(checkout, "databases", slug)
	await mkdir(join(directory, "migrations"), { recursive: true })
	await writeFile(
		join(directory, "kysely.config.ts"),
		`import { databaseDialect } from "@usecontextlayer/sdk/database"
import { defineConfig } from "kysely-ctl"
export default defineConfig({
  dialect: databaseDialect(${JSON.stringify(slug)}),
  migrations: { migrationFolder: "./migrations" },
})
`,
	)
	await writeFile(
		join(directory, "migrations/001_create_updates.ts"),
		`import { sql, type Kysely } from "kysely"
export async function up(db: Kysely<unknown>) {
  await sql\`CREATE TABLE updates (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )\`.execute(db)
}
`,
	)
}
