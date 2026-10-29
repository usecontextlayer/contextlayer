import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { writeDatabase } from "@tests/database-project"
import { executionTest as test } from "@tests/integration"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { createSlateProject } from "@usecontextlayer/dev-env/slate"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import {
	type SlateResourceConfiguration,
	slateResourcesSchema,
} from "@usecontextlayer/shared/slate-resources"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { scheduledAgentRunSchema } from "@/agents.schema"
import { organizationSchema } from "@/auth.server"
import { type Slate, slateSchema } from "@/slates.schema"

const execFile = promisify(execFileCallback)

test("native CLI provisioning initializes owner and member databases and applies schema changes", async ({
	db,
	directory: dir,
	execution,
	serviceEnv,
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
	const organizationId = organization.id
	const { ARTIFACTS } = await worker.getEnv()
	await using resources = new AsyncDisposableStack()
	const slates: Slate[] = []
	for (let index = 0; index < 2; index++) {
		const response = await fetch(
			`${origin}/api/slates`,
			post({ organization_slug: organizationSlug }),
		)
		expect(response.status, await response.clone().text()).toBe(201)
		const slate = slateSchema.parse(await response.json())
		resources.defer(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		slates.push(slate)
	}
	const [joinedBeforeProvisioning, joinedAfterProvisioning] = slates
	if (!joinedBeforeProvisioning || !joinedAfterProvisioning)
		throw new Error("Expected database test slates")
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
	const checkouts = []
	const readConfiguration = async (slate: Slate) => {
		const response = await fetch(
			`${origin}/api/slates/${slate.id}/resources/list`,
			post({}),
		)
		expect(response.status).toBe(200)
		const { resources } = slateResourcesSchema.parse(await response.json())
		return resources
	}
	const firstUse = async (slate: Slate) => {
		await using workflows =
			await provisioning.worker.introspectWorkflow("MEMBER_PROVISIONING")
		const viewerHeaders = await signInViewer({
			authURL: serviceEnv.addresses.CTX_VIEWER_AUTH_URL.origin,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		})
		const token = decodeURIComponent(
			viewerHeaders.get("cookie")?.match(/ctx-viewer-auth=([^;]+)/)?.[1] ?? "",
		)
		assert(token)
		const response = await execution.worker.fetch("http://execution/databases", {
			body: JSON.stringify([
				{ credential: { token, type: "session" }, slateId: slate.id },
				["drafts", "SELECT 1 AS joined", []],
			]),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status, await response.clone().text()).toBe(200)
		expect(await response.json()).toMatchObject({ rows: [{ joined: 1 }] })
		expect(
			await db
				.selectFrom("slate_member")
				.selectAll()
				.where("slate_id", "=", slate.id)
				.execute(),
		).toEqual([{ slate_id: slate.id, user_id: user.id }])
		for (const instance of await workflows.get()) {
			await using workflow = instance
			await workflow.waitForStatus("complete")
		}
	}
	for (const slate of slates) {
		const checkout = join(dir, slate.id)
		await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout)
		await mkdir(join(checkout, "agents/daily-summary/schedules"), { recursive: true })
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: checkout, env: gitEnv })).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Database Test")
		await git("config", "user.email", "database-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${slate.id}`)
		for (const slug of ["drafts", "inbox", "reports"]) await writeDatabase(checkout, slug)
		if (slate.id === joinedBeforeProvisioning.id) {
			await writeFile(
				join(checkout, "public/slate.json"),
				JSON.stringify({ connections: {}, databases: { drafts: { mode: "viewer" } } }),
			)
			await git("add", ".")
			await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare personal drafts")
			await git("push", "origin", "main")
			await firstUse(slate)
		}
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
				databases: { inbox: { mode: "viewer" }, reports: { mode: "owner" } },
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
		const configuration = await readConfiguration(slate)
		expect(Object.keys(configuration.databases).sort()).toEqual([
			"drafts",
			"inbox",
			"reports",
		])
		expect(configuration.databases.reports).toMatchObject({
			consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
			owner: { id: organizationId, type: "organization" },
		})
		for (const slug of ["drafts", "inbox"])
			expect(configuration.databases[slug]?.owner).toEqual({
				id: user.id,
				type: "personal",
			})
		for (const [slug, { instance_name }] of Object.entries(configuration.databases)) {
			const query = DATABASES.getByName(instance_name).query("SELECT * FROM updates")
			if (slate.id === joinedBeforeProvisioning.id && slug === "drafts")
				expect((await query).rows).toEqual([])
			else await expect(query).rejects.toThrow()
		}
		const instance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(slate.id, "daily-summary", { id: user.id, type: "user" }),
		)
		expect(await instance.listSchedules()).toEqual([])
		const prepared = await PROVISIONING.prepare(slate.id, await git("rev-parse", "HEAD"))
		{
			await using workflow = await provisioning.worker.introspectWorkflowInstance(
				"MEMBER_PROVISIONING",
				(await MEMBER_PROVISIONING.create({ params: prepared })).id,
			)
			await workflow.waitForStatus("complete")
		}
		expect(await instance.listSchedules()).toHaveLength(
			slate.id === joinedBeforeProvisioning.id ? 1 : 0,
		)
		checkouts.push({ checkout, configuration, git, instance, scheduleFile, slate })
	}
	for (const { slate, configuration } of checkouts) {
		for (const { instance_name, mode } of Object.values(configuration.databases)) {
			const query = DATABASES.getByName(instance_name).query("SELECT * FROM updates")
			if (slate.id === joinedAfterProvisioning.id && mode === "viewer")
				await expect(query).rejects.toThrow()
			else expect((await query).rows).toEqual([])
		}
	}
	await firstUse(joinedAfterProvisioning)
	for (const { configuration, instance } of checkouts) {
		expect(await instance.listSchedules()).toHaveLength(1)
		for (const { instance_name } of Object.values(configuration.databases))
			expect(
				(await DATABASES.getByName(instance_name).query("SELECT * FROM updates")).rows,
			).toEqual([])
	}
	const first = z
		.object({ instance_name: z.string() })
		.parse(checkouts[0]?.configuration.databases.reports)
	await DATABASES.getByName(first.instance_name).query(
		"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
		["cached", "email", "persisted", 1],
	)
	const second = z
		.object({ instance_name: z.string() })
		.parse(checkouts[1]?.configuration.databases.reports)
	expect(
		(await DATABASES.getByName(second.instance_name).query("SELECT * FROM updates")).rows,
	).toEqual([])
	for (const slug of ["drafts", "inbox", "reports"])
		expect(checkouts[0]?.configuration.databases[slug]?.instance_name).not.toBe(
			checkouts[1]?.configuration.databases[slug]?.instance_name,
		)
	const firstCheckout = checkouts[0]
	assert(firstCheckout)
	const { slate, checkout, git, scheduleFile, instance } = firstCheckout
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
	await writeDatabase(checkout, "archive")
	await git("add", ".")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Add a database and refresh the schedule",
	)
	await git("push", "origin", "main")
	const configuration: SlateResourceConfiguration = await readConfiguration(slate)
	const archive = configuration.databases.archive
	if (!archive) throw new Error("Expected new archive declaration")
	const reports = z
		.object({ instance_name: z.string() })
		.parse(configuration.databases.reports)
	await expect(
		DATABASES.getByName(archive.instance_name).query("SELECT * FROM updates"),
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
		(await DATABASES.getByName(reports.instance_name).query("SELECT source FROM updates"))
			.rows,
	).toEqual([{ source: "email" }])
	expect(
		(await DATABASES.getByName(archive.instance_name).query("SELECT * FROM updates"))
			.rows,
	).toEqual([])
	const schedules = z
		.array(z.object({ payload: scheduledAgentRunSchema }))
		.parse(await instance.listSchedules())
	expect(schedules).toHaveLength(1)
	expect(schedules[0]?.payload.prompt).toContain("refreshed scheduled document")
}, 1_800_000)
