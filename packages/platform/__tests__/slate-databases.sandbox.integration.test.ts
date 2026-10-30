import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { writeDatabase } from "@tests/database-project"
import { test } from "@tests/integration"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { slateResourcesSchema } from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { scheduledAgentRunSchema } from "@/agents.schema"
import { organizationSchema } from "@/auth.server"
import { slateMemberSchema } from "@/slate-members.schema"
import { slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("reprovisioning migrates new databases, preserves owner data and replaces member schedules", async ({
	db,
	directory: dir,
	webSession,
	platform,
	provisioning,
}) => {
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const { origin, worker } = platform
	const { user } = webSession
	const headers = { ...Object.fromEntries(webSession.headers), origin }
	const memberships = await fetch(
		new URL("/api/platform/organizations", platform.env.CTX_AUTH_ISSUER),
		{ headers },
	)
	expect(memberships.status).toBe(200)
	const organization = z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await memberships.json())
		.organizations.find((item) => item.slug === seed.web.organization.slug)
	assert(organization)
	const organizationSlug = organization.slug
	const { ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	const response = await fetch(
		`${origin}/api/slates`,
		post({ organization_slug: organizationSlug }),
	)
	expect(response.status, await response.clone().text()).toBe(201)
	const slate = slateSchema.parse(await response.json())
	resources.defer(async () => {
		await ARTIFACTS.delete(slate.id)
	})
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: user.id }))
		.execute()
	const { DATABASES, AGENTS } = await worker.getEnv()
	const { PROVISIONING, MEMBER_PROVISIONING } = await provisioning.worker.getEnv()
	const gitEnv = {
		...process.env,
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_KEY_1: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Cookie: ${webSession.headers.get("cookie")}`,
		GIT_CONFIG_VALUE_1: `Origin: ${origin}`,
		GIT_TERMINAL_PROMPT: "0",
	}
	const readConfiguration = async () => {
		const response = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(response.status).toBe(200)
		const { resources } = slateResourcesSchema.parse(await response.json())
		return resources
	}
	const checkout = join(dir, slate.id)
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
	await mkdir(join(checkout, "agents/daily-summary/schedules"), { recursive: true })
	const git = async (...args: string[]) =>
		(await execFile("git", args, { cwd: checkout, env: gitEnv })).stdout.trim()
	await git("init", "-b", "main")
	await git("config", "user.name", "Database Test")
	await git("config", "user.email", "database-test@example.com")
	await git("remote", "add", "origin", `${origin}/git/${slate.id}`)
	for (const slug of ["drafts", "reports"]) await writeDatabase(checkout, slug)
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(checkout, "agents/daily-summary/slate.json"),
		JSON.stringify({
			connections: {},
			databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
		}),
	)
	await writeFile(
		join(checkout, "agents/daily-summary/instructions.md"),
		"Save scheduled documents in declared databases.\n",
	)
	const scheduleFile = join(checkout, "agents/daily-summary/schedules/documents.md")
	await writeFile(
		scheduleFile,
		'---\ncron: "0 0 1 1 *"\n---\nSave a scheduled document.\n',
	)
	await git("add", ".")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Declare app and agent databases",
	)
	await git("push", "origin", "main")
	const initialConfiguration = await readConfiguration()
	const initialReports = initialConfiguration.databases.reports
	assert(initialReports)
	for (const { instance_name } of Object.values(initialConfiguration.databases))
		await expect(
			DATABASES.getByName(instance_name).query("SELECT * FROM updates"),
		).rejects.toThrow()
	const instance = await getAgentByName(
		AGENTS,
		getAgentInstanceName(slate.id, "daily-summary", { id: user.id, type: "user" }),
	)
	expect(await instance.listSchedules()).toEqual([])
	const initialPrepared = await PROVISIONING.prepare(
		slate.id,
		await git("rev-parse", "HEAD"),
	)
	{
		await using workflow = await provisioning.worker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: initialPrepared })).id,
		)
		await workflow.waitForStatus("complete")
	}
	expect(await instance.listSchedules()).toHaveLength(1)
	for (const { instance_name } of Object.values(initialConfiguration.databases))
		expect(
			(await DATABASES.getByName(instance_name).query("SELECT * FROM updates")).rows,
		).toEqual([])
	await DATABASES.getByName(initialReports.instance_name).query(
		"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
		["cached", "email", "persisted", 1],
	)
	const migration = "002_add_source.ts"
	await writeFile(
		join(checkout, "databases/reports/migrations", migration),
		`import { sql, type Kysely } from "kysely"
export async function up(db: Kysely<unknown>) {
  await sql\`ALTER TABLE updates ADD COLUMN source TEXT NOT NULL DEFAULT 'email'\`.execute(db)
}
`,
	)
	await writeFile(
		join(checkout, "public/slate.json"),
		JSON.stringify({
			connections: {},
			databases: {
				archive: { mode: "owner" },
				drafts: { mode: "viewer" },
				reports: { mode: "owner" },
			},
		}),
	)
	await writeFile(
		scheduleFile,
		'---\ncron: "0 1 1 1 *"\n---\nSave a refreshed scheduled document.\n',
	)
	await writeFile(
		join(checkout, "agents/daily-summary/slate.json"),
		JSON.stringify({
			connections: {},
			databases: {
				drafts: { mode: "viewer" },
				inbox: { mode: "viewer" },
				reports: { mode: "owner" },
			},
		}),
	)
	for (const slug of ["archive", "inbox"]) await writeDatabase(checkout, slug)
	await git("add", ".")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Add databases and refresh the schedule",
	)
	await git("push", "origin", "main")
	const configuration = await readConfiguration()
	const archive = configuration.databases.archive
	const inbox = configuration.databases.inbox
	const reports = configuration.databases.reports
	assert(archive && inbox && reports)
	for (const { instance_name } of [archive, inbox])
		await expect(
			DATABASES.getByName(instance_name).query("SELECT * FROM updates"),
		).rejects.toThrow()
	const prepared = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
	{
		await using workflow = await provisioning.worker.introspectWorkflowInstance(
			"MEMBER_PROVISIONING",
			(await MEMBER_PROVISIONING.create({ params: prepared })).id,
		)
		await workflow.waitForStatus("complete")
	}
	expect(
		(
			await DATABASES.getByName(reports.instance_name).query("PRAGMA table_info(updates)")
		).rows.map((row) => row.name),
	).toContain("source")
	expect(
		(
			await DATABASES.getByName(reports.instance_name).query(
				"SELECT id, body, source FROM updates",
			)
		).rows,
	).toEqual([{ body: "persisted", id: "cached", source: "email" }])
	for (const { instance_name } of [archive, inbox])
		expect(
			(await DATABASES.getByName(instance_name).query("SELECT * FROM updates")).rows,
		).toEqual([])
	const schedules = z
		.array(z.object({ payload: scheduledAgentRunSchema }))
		.parse(await instance.listSchedules())
	expect(schedules).toHaveLength(1)
	expect(schedules[0]?.payload.prompt).toContain("refreshed scheduled document")
}, 1_800_000)
