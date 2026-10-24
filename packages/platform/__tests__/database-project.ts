import { execFile as execFileCallback } from "node:child_process"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

export async function writeDatabaseProject(checkout: string) {
	const cli = join(import.meta.dirname, "../../cli")
	await execFile(
		"pnpm",
		[
			"exec",
			"create-react-router",
			checkout,
			"--template",
			join(cli, "dist/template.tar.gz"),
			"--package-manager",
			"pnpm",
			"--no-install",
			"--no-git-init",
			"--yes",
		],
		{ cwd: cli },
	)
	const packages = join(checkout, "packages")
	await mkdir(packages, { recursive: true })
	await Promise.all(
		["cli", "sdk"].map((name) =>
			execFile("pnpm", ["pack", "--out", join(packages, `${name}.tgz`)], {
				cwd: join(import.meta.dirname, "../..", name),
			}),
		),
	)
	await appendFile(
		join(checkout, "pnpm-workspace.yaml"),
		"\noverrides:\n  '@usecontextlayer/cli': 'file:packages/cli.tgz'\n  '@usecontextlayer/sdk': 'file:packages/sdk.tgz'\n",
	)
	await execFile("pnpm", ["install"], { cwd: checkout })
}

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
