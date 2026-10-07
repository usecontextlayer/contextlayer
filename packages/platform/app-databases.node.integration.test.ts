import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import {
	type AppResourceConfiguration,
	appResourcesSchema,
} from "@usecontextlayer/shared/app-resources"
import { getAgentByName } from "agents/routing"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import { scheduledAgentRunSchema } from "@/agents.schema"
import { type App, appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import type { Publication } from "@/publication.server"

const execFile = promisify(execFileCallback)
const worker = createTestHarness()
const appIds: string[] = []
let databases: ProvisionedDatabases<"ctx_app_databases">
let db: ReturnType<typeof createPlatformDb>
let env: ReturnType<typeof parsePlatformEnv>
let dir: string
let origin: string
let headers: { authorization: string }

beforeAll(async () => {
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_app_databases: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_app_databases)
	env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_app_databases,
	})
	headers = {
		authorization: `Bearer ${z.string().min(1).parse(process.env.CTX_TEST_ACCESS_TOKEN)}`,
	}
	dir = await mkdtemp(join(tmpdir(), "ctx-app-databases-"))
	await worker.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: env,
			},
			{
				configPath: new URL("../build/wrangler.jsonc", import.meta.url),
				env: "test",
			},
		],
	})
	origin = (await worker.listen()).url.origin
})

afterAll(async () => {
	try {
		if (appIds.length === 0) return
		const { ARTIFACTS } = await worker.getWorker<PlatformEnv["Bindings"]>().getEnv()
		for (const id of appIds) await ARTIFACTS.delete(id)
	} finally {
		await worker.close()
		if (dir) await rm(dir, { force: true, recursive: true })
		await db?.destroy()
		await databases?.dropAll()
	}
})

test("join and publication provision only members' declared app and agent databases", async () => {
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const identity = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), { headers })
	expect(identity.status).toBe(200)
	const user = z.object({ id: z.string().min(1) }).parse(await identity.json())
	const organizationSlug = z.string().min(1).parse(process.env.CTX_TEST_ORGANIZATION_SLUG)
	const organizationId = z.string().min(1).parse(process.env.CTX_TEST_ORGANIZATION_ID)
	await saveCustomerState(
		db,
		await getStateExternalCustomers(
			createPolarCore({
				accessToken: env.POLAR_ACCESS_TOKEN,
				environment: env.POLAR_ENVIRONMENT,
			}),
		)(organizationId),
		null,
	)
	const apps: App[] = []
	for (let index = 0; index < 2; index++) {
		const response = await fetch(
			`${origin}/api/apps`,
			post({ organization_slug: organizationSlug }),
		)
		expect(response.status, await response.clone().text()).toBe(201)
		const app = appSchema.parse(await response.json())
		appIds.push(app.id)
		apps.push(app)
	}
	const [joinedBeforePublication, joinedAfterPublication] = apps
	if (!joinedBeforePublication || !joinedAfterPublication)
		throw new Error("Expected database test apps")
	await db
		.deleteFrom("app_member")
		.where("app_id", "=", joinedAfterPublication.id)
		.execute()
	const { DATABASES, AGENTS } = await worker.getWorker<PlatformEnv["Bindings"]>().getEnv()
	const { PUBLICATION } = await worker
		.getWorker<{ PUBLICATION: Service<Publication> }>("contextlayer-build-test")
		.getEnv()
	const gitEnv = {
		...process.env,
		CTX_AUTH_ISSUER: env.CTX_AUTH_ISSUER,
		CTX_PLATFORM_URL: origin,
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	}
	const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
	await execFile(
		"git",
		["config", "--global", `credential.${origin}/git.helper`, `${cli} git-credential`],
		{
			cwd: dir,
			env: gitEnv,
		},
	)
	const projects = []
	const readConfiguration = async (app: App) => {
		const response = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(response.status).toBe(200)
		const { resources } = appResourcesSchema.parse(await response.json())
		return resources
	}
	const joinMember = async (app: App) => {
		const response = await fetch(`${origin}/api/apps/${app.id}/join`, {
			headers,
			method: "POST",
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ app_id: app.id, user_id: user.id })
	}
	await joinMember(joinedBeforePublication)
	for (const app of apps) {
		const project = join(dir, app.id)
		await mkdir(join(project, "agents/daily-summary/schedules"), { recursive: true })
		await mkdir(join(project, "public"))
		const git = async (...args: string[]) =>
			(await execFile("git", args, { cwd: project, env: gitEnv })).stdout.trim()
		await git("init", "-b", "main")
		await git("config", "user.name", "Database Test")
		await git("config", "user.email", "database-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${app.id}`)
		await writeFile(
			join(project, "public/slate.json"),
			JSON.stringify({
				connections: {},
				databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(project, "agents/daily-summary/slate.json"),
			JSON.stringify({
				connections: {},
				databases: { inbox: { mode: "viewer" }, reports: { mode: "owner" } },
			}),
		)
		await writeFile(
			join(project, "agents/daily-summary/instructions.md"),
			"Save scheduled documents in declared databases.\n",
		)
		const scheduleFile = join(project, "agents/daily-summary/schedules/documents.md")
		await writeFile(
			scheduleFile,
			'---\ncron: "0 0 1 1 *"\n---\nSave a scheduled document.\n',
		)
		for (const slug of ["drafts", "inbox", "reports"])
			await cp(
				new URL("../cli/template/databases/updates/migrations/", import.meta.url),
				join(project, "databases", slug, "migrations"),
				{ recursive: true },
			)
		await git("add", "public", "agents", "databases")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Declare app and agent databases",
		)
		await git("push", "origin", "main")
		const configuration = await readConfiguration(app)
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
			expect(configuration.databases[slug]?.owner).toEqual({ id: user.id, type: "user" })
		for (const { instance_name } of Object.values(configuration.databases))
			await expect(
				DATABASES.getByName(instance_name).query("SELECT * FROM updates"),
			).rejects.toThrow()
		await PUBLICATION.publish(app.id)
		const instance = await getAgentByName(
			AGENTS,
			getAgentInstanceName(app.id, "daily-summary", { id: user.id, type: "user" }),
		)
		expect(await instance.listSchedules()).toHaveLength(
			app.id === joinedBeforePublication.id ? 1 : 0,
		)
		projects.push({ app, configuration, git, instance, project, scheduleFile })
	}
	for (const { app, configuration } of projects) {
		for (const { instance_name } of Object.values(configuration.databases)) {
			const query = DATABASES.getByName(instance_name).query("SELECT * FROM updates")
			if (app.id === joinedAfterPublication.id) await expect(query).rejects.toThrow()
			else expect((await query).rows).toEqual([])
		}
	}
	await joinMember(joinedAfterPublication)
	for (const { configuration, instance } of projects) {
		expect(await instance.listSchedules()).toHaveLength(1)
		for (const { instance_name } of Object.values(configuration.databases))
			expect(
				(await DATABASES.getByName(instance_name).query("SELECT * FROM updates")).rows,
			).toEqual([])
	}
	const first = z
		.object({ instance_name: z.string() })
		.parse(projects[0]?.configuration.databases.reports)
	await DATABASES.getByName(first.instance_name).query(
		"INSERT INTO updates (id, kind, body, created_at) VALUES (?, ?, ?, ?)",
		["cached", "email", "persisted", 1],
	)
	const second = z
		.object({ instance_name: z.string() })
		.parse(projects[1]?.configuration.databases.reports)
	expect(
		(await DATABASES.getByName(second.instance_name).query("SELECT * FROM updates")).rows,
	).toEqual([])
	for (const slug of ["drafts", "inbox", "reports"])
		expect(projects[0]?.configuration.databases[slug]?.instance_name).not.toBe(
			projects[1]?.configuration.databases[slug]?.instance_name,
		)
	for (const { app, project, git, scheduleFile, instance } of projects) {
		await joinMember(app)
		await execFile(
			join(import.meta.dirname, "../cli/node_modules/.bin/drizzle-kit"),
			[
				"generate",
				"--custom",
				"--dialect",
				"sqlite",
				"--driver",
				"durable-sqlite",
				"--schema",
				join(import.meta.dirname, "../cli/template/databases/updates/schema.ts"),
				"--out",
				"databases/reports/migrations",
				"--name",
				"add_source",
			],
			{ cwd: project },
		)
		await writeFile(
			join(project, "databases/reports/migrations/0001_add_source.sql"),
			"ALTER TABLE updates ADD COLUMN source TEXT NOT NULL DEFAULT 'email';\n",
		)
		await writeFile(
			join(project, "public/slate.json"),
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
		await git("add", "public", "agents", "databases")
		await git(
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Add a database and refresh the schedule",
		)
		await git("push", "origin", "main")
		const configuration: AppResourceConfiguration = await readConfiguration(app)
		const archive = configuration.databases.archive
		if (!archive) throw new Error("Expected new archive declaration")
		const reports = z
			.object({ instance_name: z.string() })
			.parse(configuration.databases.reports)
		await cp(
			new URL("../cli/template/databases/updates/migrations/", import.meta.url),
			join(project, "databases/archive/migrations"),
			{ recursive: true },
		)
		await git("add", "databases")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Add archive migrations")
		await git("push", "origin", "main")
		await expect(
			DATABASES.getByName(archive.instance_name).query("SELECT * FROM updates"),
		).rejects.toThrow()
		await PUBLICATION.publish(app.id)
		expect(
			(
				await DATABASES.getByName(reports.instance_name).query(
					"PRAGMA table_info(updates)",
				)
			).rows.map((row) => row[1]),
		).toContain("source")
		expect(
			(
				await DATABASES.getByName(reports.instance_name).query(
					"SELECT source FROM updates",
				)
			).rows,
		).toEqual(app.id === joinedBeforePublication.id ? [["email"]] : [])
		expect(
			(await DATABASES.getByName(archive.instance_name).query("SELECT * FROM updates"))
				.rows,
		).toEqual([])
		const schedules = z
			.array(z.object({ payload: scheduledAgentRunSchema }))
			.parse(await instance.listSchedules())
		expect(schedules).toHaveLength(1)
		expect(schedules[0]?.payload.prompt).toContain("refreshed scheduled document")
		await PUBLICATION.publish(app.id)
	}
	const result = await fetch(
		`${origin}/api/apps/${joinedBeforePublication.id}/databases/query`,
		post({
			params: ["email"],
			slug: "reports",
			sql: "SELECT body FROM updates WHERE kind = ?",
		}),
	)
	expect(result.status).toBe(200)
	expect(await result.json()).toMatchObject({ rows: [["persisted"]] })
	const undeclared = await fetch(
		`${origin}/api/apps/${joinedBeforePublication.id}/databases/query`,
		post({ slug: "inbox", sql: "SELECT * FROM updates" }),
	)
	expect(undeclared.status).toBe(404)
}, 120_000)
