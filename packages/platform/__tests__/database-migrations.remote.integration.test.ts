import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { test as base } from "@tests/database"
import { copySlateProject } from "@usecontextlayer/dev-env/slate"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"
import type { PlatformEnv } from "@/context"
import type { Provisioning } from "@/provisioning.server"
import { slateMemberSchema } from "@/slate-members.schema"
import { prepareSlateProvisioning } from "@/slate-provisioning.server"
import { slateSchema } from "@/slates.schema"
// biome-ignore lint/style/noRestrictedImports: shared Worker fixtures live outside the package
import * as workerFixtures from "../../../vitest.workers.ts"

const execFile = promisify(execFileCallback)

const test = base.extend(
	"workers",
	({ databases }): workerFixtures.WorkerInputs => [
		{
			...workerFixtures.platformWorkerInput,
			secrets: { CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_platform_test },
		},
		workerFixtures.buildWorkerInput,
	],
)

test("reprovisioning preserves data, refreshes schedules, and stops on migration failure", async ({
	db,
	harness,
}) => {
	await using resources = new AsyncDisposableStack()
	const directory = await mkdtemp(join(tmpdir(), "slate-migrations-"))
	resources.defer(() => rm(directory, { force: true, recursive: true }))
	await harness.listen()
	const { AGENTS, ARTIFACTS, DATABASES } = await harness
		.getWorker<PlatformEnv["Bindings"]>("contextlayer-platform-test")
		.getEnv()
	const buildWorker = harness.getWorker<{
		MEMBER_PROVISIONING: Workflow<SlateProvisioning>
		PROVISIONING: Service<Provisioning>
	}>("contextlayer-build-test")
	const { MEMBER_PROVISIONING, PROVISIONING } = await buildWorker.getEnv()
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
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}`,
				},
			})
		).stdout.trim()
	await copySlateProject(directory)
	await writeFile(
		join(directory, "public/slate.json"),
		JSON.stringify({ connections: {}, databases: { notes: { mode: "viewer" } } }),
	)
	await mkdir(join(directory, "agents/daily/schedules"), { recursive: true })
	await writeFile(
		join(directory, "agents/daily/instructions.md"),
		"Keep the declared notes up to date.\n",
	)
	await writeFile(
		join(directory, "agents/daily/slate.json"),
		JSON.stringify({ connections: {}, databases: { notes: { mode: "viewer" } } }),
	)
	const schedulePath = join(directory, "agents/daily/schedules/notes.md")
	await writeFile(schedulePath, '---\ncron: "0 0 1 1 *"\n---\nReview the notes.\n')
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
		await database.query("INSERT INTO notes (body) VALUES (?)", [selected.owner.id])
	}
	await expect(
		DATABASES.getByName(unselected.instance_name).query("SELECT * FROM notes"),
	).rejects.toThrow()
	for (const id of ["first", "second"]) {
		const agent = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily", { id, type: "user" }),
		)
		expect(await agent.listAuthoredSchedules()).toMatchObject([
			{
				payload: { actor: { id, type: "user" }, name: "daily", schedule: "notes" },
			},
		])
	}

	await writeFile(
		join(directory, "databases/notes/migrations/002_add_source.ts"),
		`import { sql, type Kysely } from "kysely"
export async function up(db: Kysely<unknown>) {
  await sql\`ALTER TABLE notes ADD COLUMN source TEXT NOT NULL DEFAULT 'authored'\`.execute(db)
}
`,
	)
	await writeFile(
		schedulePath,
		'---\ncron: "0 1 1 1 *"\n---\nReview the refreshed notes.\n',
	)
	await git("add", "databases", "agents")
	await git("-c", "commit.gpgsign=false", "commit", "-m", "Revise database and schedule")
	await git("push", repo.remote, "main")
	const revised = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
	{
		await using workflow = await buildWorker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: revised })).id,
		)
		await workflow.waitForStatus("complete")
	}
	for (const selected of revised.databases) {
		expect(
			(
				await DATABASES.getByName(selected.instance_name).query(
					"SELECT body, source FROM notes",
				)
			).rows,
		).toEqual([{ body: selected.owner.id, source: "authored" }])
	}
	for (const id of ["first", "second"]) {
		const agent = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily", { id, type: "user" }),
		)
		expect(await agent.listAuthoredSchedules()).toMatchObject([
			{
				cron: "0 1 1 1 *",
				payload: { prompt: expect.stringContaining("refreshed notes") },
			},
		])
	}

	await writeFile(
		join(directory, "databases/notes/migrations/003_failure.ts"),
		`import { sql, type Kysely } from "kysely"
export async function up(db: Kysely<unknown>) {
  await sql\`CREATE TABLE partial_migration (id TEXT NOT NULL)\`.execute(db)
  await sql\`ALTER TABLE nonexistent_migration_table ADD COLUMN value TEXT\`.execute(db)
}
`,
	)
	await writeFile(
		schedulePath,
		'---\ncron: "0 2 1 1 *"\n---\nReview the notes after the failing migration.\n',
	)
	await git("add", "databases", "agents")
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
		expect((await database.query("SELECT body, source FROM notes")).rows).toEqual([
			{ body: selected.owner.id, source: "authored" },
		])
		expect((await database.query("SELECT name FROM kysely_migration")).rows).toEqual([
			{ name: "001_create_notes" },
			{ name: "002_add_source" },
		])
	}
	for (const id of ["first", "second"]) {
		const agent = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily", { id, type: "user" }),
		)
		expect(await agent.listAuthoredSchedules()).toMatchObject([
			{
				cron: "0 1 1 1 *",
				payload: { prompt: expect.stringContaining("refreshed notes") },
			},
		])
	}
}, 900_000)
