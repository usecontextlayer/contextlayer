import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { test as base } from "@tests/database"
import type { Workers } from "@tests/workers"
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import { expect } from "vitest"
import type { PlatformEnv } from "@/context"
import type { Provisioning } from "@/provisioning.server"
import { slateMemberSchema } from "@/slate-members.schema"
import { prepareSlateProvisioning } from "@/slate-provisioning.server"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

const test = base.extend(
	"workers",
	({ databases }): Workers => [
		{
			configPath: new URL("../wrangler.jsonc", import.meta.url),
			env: "test",
			prebuiltWorkerDir: new URL("../build/server", import.meta.url),
			secrets: { CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test },
		},
		{
			configPath: new URL("../../build/wrangler.jsonc", import.meta.url),
			env: "test",
		},
	],
)

test("native sandbox CLI migrates its selected instances and preserves native failure semantics", async ({
	db,
	harness,
}) => {
	await using resources = new AsyncDisposableStack()
	const directory = await mkdtemp(join(tmpdir(), "slate-migrations-"))
	resources.defer(() => rm(directory, { force: true, recursive: true }))
	await harness.listen()
	const { ARTIFACTS, DATABASES } = await harness
		.getWorker<PlatformEnv["Bindings"]>("contextlayer-platform-test")
		.getEnv()
	const buildWorker = harness.getWorker<{
		PROVISIONING: Service<Provisioning>
		MEMBER_PROVISIONING: Workflow<SlateProvisioning>
	}>("contextlayer-build-test")
	const { PROVISIONING, MEMBER_PROVISIONING } = await buildWorker.getEnv()
	const slate = slateSchema.parse({
		id: crypto.randomUUID(),
		owner_organization_id: null,
		owner_user_id: "migration-acceptance",
		public_hostname: "migration-acceptance",
		visibility: "private",
	})
	await db.insertInto("slate").values(slate).execute()
	await db
		.insertInto("slate_member")
		.values(
			["first", "second"].map((user_id) =>
				slateMemberSchema.parse({ slate_id: slate.id, user_id }),
			),
		)
		.execute()
	const repo = await ARTIFACTS.create(slate.id)
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	const git = async (...args: string[]) =>
		(
			await execFile("git", args, {
				cwd: directory,
				env: {
					...process.env,
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}`,
					GIT_TERMINAL_PROMPT: "0",
				},
			})
		).stdout.trim()
	await createSlateProject(resolve(import.meta.dirname, "../../.."), directory)
	await writeFile(
		join(directory, "app/slate.json"),
		JSON.stringify({ connections: {}, databases: { notes: { mode: "viewer" } } }),
	)
	await git("init", "-b", "main")
	await git("config", "user.name", "Migration Acceptance")
	await git("config", "user.email", "migration-acceptance@example.com")
	await git("add", ".")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Author native migration")
	await git("push", repo.remote, "main")
	const prepared = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
	const other = prepareSlateProvisioning(
		slate,
		[{ id: "unselected", type: "user" }],
		prepared.snapshot,
	)
	const unselected = other.databases[0]
	assert(unselected)
	expect(prepared.databases).toHaveLength(2)
	await using workflow = await buildWorker.introspectWorkflowInstance(
		"MEMBER_PROVISIONING",
		(await MEMBER_PROVISIONING.create({ params: prepared })).id,
	)
	await workflow.waitForStatus("complete")
	for (const selected of prepared.databases) {
		const database = DATABASES.getByName(selected.instance_name)
		expect((await database.query("SELECT * FROM notes")).rows).toEqual([])
		expect((await database.query("SELECT name FROM kysely_migration")).rows).toEqual([
			{ name: "001_create_notes" },
		])
	}
	await expect(
		DATABASES.getByName(unselected.instance_name).query("SELECT * FROM notes"),
	).rejects.toThrow()

	await writeFile(
		join(directory, "databases/notes/migrations/002_failure.ts"),
		`import { sql, type Kysely } from "kysely"
export async function up(db: Kysely<unknown>) {
  await sql\`CREATE TABLE partial_migration (id TEXT NOT NULL)\`.execute(db)
  await sql\`ALTER TABLE nonexistent_migration_table ADD COLUMN value TEXT\`.execute(db)
}
`,
	)
	await git("add", "databases")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Author failing migration")
	await git("push", repo.remote, "main")
	const failed = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
	await using failedWorkflow = await buildWorker.introspectWorkflowInstance(
		"MEMBER_PROVISIONING",
		(await MEMBER_PROVISIONING.create({ params: failed })).id,
	)
	await failedWorkflow.waitForStatus("errored")
	expect(await failedWorkflow.getError()).toMatchObject({
		message: expect.stringContaining("nonexistent_migration_table"),
	})
	const [first, later] = failed.databases
	assert(first && later)
	expect(
		(
			await DATABASES.getByName(first.instance_name).query(
				"SELECT * FROM partial_migration",
			)
		).rows,
	).toEqual([])
	await expect(
		DATABASES.getByName(later.instance_name).query("SELECT * FROM partial_migration"),
	).rejects.toThrow()
	for (const selected of failed.databases) {
		const database = DATABASES.getByName(selected.instance_name)
		expect((await database.query("SELECT * FROM notes")).rows).toEqual([])
		expect((await database.query("SELECT name FROM kysely_migration")).rows).toEqual([
			{ name: "001_create_notes" },
		])
	}
}, 900_000)
