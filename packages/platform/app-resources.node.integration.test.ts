import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { appResourcesSchema } from "@usecontextlayer/shared/app-resources"
import { connectionsSchema } from "@usecontextlayer/shared/connections"
import { appSlatesSchema, collectAppResources } from "@usecontextlayer/shared/slate"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { listOrganizations } from "@/auth.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const execFile = promisify(execFileCallback)

const configSchema = z.object({
	CTX_TEST_ACCESS_TOKEN: z.string().min(1),
	CTX_TEST_ORGANIZATION_ID: z.string().min(1),
})

const worker = createTestHarness()
const appIds: string[] = []
let config: z.infer<typeof configSchema>
let databases: ProvisionedDatabases<"ctx_app_resources">
let db: ReturnType<typeof createPlatformDb>
let env: ReturnType<typeof parsePlatformEnv>
let dir: string
let headers: { authorization: string }
let origin: string

beforeAll(async () => {
	config = configSchema.parse(process.env)
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_app_resources: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_app_resources)
	env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_app_resources,
	})
	dir = await mkdtemp(join(tmpdir(), "ctx-app-resources-"))
	headers = { authorization: `Bearer ${config.CTX_TEST_ACCESS_TOKEN}` }
	await worker.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: env,
			},
		],
	})
	origin = (await worker.listen()).url.origin
})

afterAll(async () => {
	try {
		for (const id of appIds) {
			const { ARTIFACTS } = await worker.getWorker<PlatformEnv["Bindings"]>().getEnv()
			await ARTIFACTS.delete(id)
		}
	} finally {
		await worker.close()
		if (dir) await rm(dir, { force: true, recursive: true })
		await db?.destroy()
		await databases?.dropAll()
	}
})

test("hosted API and Chrome configure pushed app and agent resources independently of developer-local configuration", async () => {
	const identity = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), { headers })
	expect(identity.status).toBe(200)
	const user = z.object({ id: z.string().min(1) }).parse(await identity.json())
	const organizations = await listOrganizations(
		{ credential: { token: config.CTX_TEST_ACCESS_TOKEN, type: "access-token" }, user },
		env.CTX_AUTH_ISSUER,
	)
	const owningOrganization = organizations.find(
		(organization) => organization.id === config.CTX_TEST_ORGANIZATION_ID,
	)
	if (!owningOrganization) throw new Error("Expected test organization membership")
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const apps = []
	for (const body of [{}, { organization_slug: owningOrganization.slug }]) {
		const response = await fetch(`${origin}/api/apps`, post(body))
		expect(response.status).toBe(201)
		const app = appSchema.parse(await response.json())
		appIds.push(app.id)
		apps.push(app)
	}
	const [personal, organization] = apps
	if (!personal || !organization) throw new Error("Expected test apps")
	const accountsResponse = await fetch(`${origin}/api/connections?toolkit=gmail`, {
		headers,
	})
	expect(accountsResponse.status).toBe(200)
	const mailAccount = connectionsSchema.parse(await accountsResponse.json())
		.connections[0]
	if (!mailAccount) throw new Error("Expected an authorized active Gmail account")
	const publicViewer = await db
		.insertInto("app")
		.values({
			owner_organization_id: null,
			owner_user_id: `test-other-owner-${crypto.randomUUID()}`,
			public_hostname: "public-viewer.example.com",
			visibility: "public",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
	const command = async (...args: string[]) =>
		await execFile(process.execPath, [cli, ...args], {
			cwd: dir,
			env: {
				...process.env,
				CTX_AUTH_ISSUER: env.CTX_AUTH_ISSUER,
				CTX_PLATFORM_URL: origin,
			},
		})
	const listedAccounts = await command("connections", "list")
	expect(listedAccounts.stdout).toContain("ACTIVE")
	expect(listedAccounts.stdout).not.toContain("EXPIRED")
	const gitEnv = {
		...process.env,
		CTX_AUTH_ISSUER: env.CTX_AUTH_ISSUER,
		CTX_PLATFORM_URL: origin,
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	}
	const git = async (...args: string[]) =>
		execFile("git", args, { cwd: dir, env: gitEnv })
	await git(
		"config",
		"--global",
		`credential.${origin}/git.helper`,
		`${cli} git-credential`,
	)
	await mkdir(join(dir, "public"))
	await mkdir(join(dir, "agents/daily-summary"), { recursive: true })
	const declarations = appSlatesSchema.parse({
		agents: {
			"daily-summary": {
				connections: {
					mail: { mode: "viewer", toolkit: "gmail" },
					repository: { mode: "owner", toolkit: "github" },
				},
				databases: { reports: { mode: "owner" } },
				secrets: { MODEL_KEY: { mode: "owner" } },
			},
		},
		app: {
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { priorities: { mode: "viewer" }, reports: { mode: "owner" } },
			secrets: { PERSONAL_KEY: { mode: "viewer" } },
		},
	})
	await writeFile(join(dir, "public/slate.json"), JSON.stringify(declarations.app))
	const agentSlate = join(dir, "agents/daily-summary/slate.json")
	await writeFile(agentSlate, JSON.stringify(declarations.agents["daily-summary"]))
	await git("init", "-b", "main")
	await git("config", "user.name", "Resources Test")
	await git("config", "user.email", "resources-test@example.com")
	await git("remote", "add", "origin", `${origin}/git/${personal.id}`)
	expect((await command("connections", "local", "list")).stdout).toContain("repository")
	await writeFile(
		join(dir, ".contextlayer/connections.json"),
		JSON.stringify({ repository: "developer-local-repository" }),
	)
	await git("add", "public", "agents", ".gitignore")
	await git(
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Declare app and agent resources",
	)
	for (const app of [personal, organization]) {
		await git("remote", "set-url", "origin", `${origin}/git/${app.id}`)
		await git("push", "origin", "main")
		expect((await command("connections", "local", "list")).stdout).toContain("repository")
		expect((await command("connections", "local", "list")).stdout).toContain(
			"developer-local-repository",
		)
		const unassigned = await fetch(
			`${origin}/api/apps/${app.id}/resources/list`,
			post({}),
		)
		expect(unassigned.status).toBe(200)
		expect(
			appResourcesSchema.parse(await unassigned.json()).resources.connections.repository
				?.connection_id,
		).toBeNull()
		expect(
			await db
				.selectFrom("app_connection_assignment")
				.selectAll()
				.where("app_id", "=", app.id)
				.execute(),
		).toEqual([])
		const assigned = await fetch(
			`${origin}/api/apps/${app.id}/connections/assign`,
			post({ connection_id: "test-repository", slug: "repository" }),
		)
		expect(assigned.status).toBe(200)
		expect(
			await db
				.selectFrom("app_connection_assignment")
				.select(["slug", "connection_id", "owner_type", "owner_id"])
				.where("app_id", "=", app.id)
				.execute(),
		).toEqual([
			{
				connection_id: "test-repository",
				owner_id: app === personal ? user.id : config.CTX_TEST_ORGANIZATION_ID,
				owner_type: app === personal ? "user" : "organization",
				slug: "repository",
			},
		])
		const response = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(response.status).toBe(200)
		const { resources: configuration } = appResourcesSchema.parse(await response.json())
		const viewer = { id: user.id, type: "user" }
		const owner =
			app === personal
				? viewer
				: { id: config.CTX_TEST_ORGANIZATION_ID, type: "organization" }
		expect(configuration).toEqual({
			connections: {
				mail: {
					connection_id: null,
					consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
					mode: "viewer",
					owner: viewer,
					toolkit: "gmail",
				},
				repository: {
					connection_id: "test-repository",
					consumers: [{ name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
					toolkit: "github",
				},
			},
			databases: {
				priorities: {
					consumers: [{ type: "app" }],
					instance_name: expect.stringMatching(/.+/),
					mode: "viewer",
					owner: viewer,
				},
				reports: {
					consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
					instance_name: expect.stringMatching(/.+/),
					mode: "owner",
					owner,
				},
			},
			secrets: {
				MODEL_KEY: {
					consumers: [{ name: "daily-summary", type: "agent" }],
					mode: "owner",
					owner,
				},
				PERSONAL_KEY: { consumers: [{ type: "app" }], mode: "viewer", owner: viewer },
			},
		})
		const chromeUrl = new URL(`/dashboard/chrome/apps/${app.id}`, origin)
		chromeUrl.searchParams.set("parentOrigin", `https://${app.public_hostname}`)
		const chromeHeaders = { ...headers, accept: "text/html" }
		const chrome = await fetch(chromeUrl, { headers: chromeHeaders })
		expect(chrome.status).toBe(200)
		expect(chrome.headers.get("content-security-policy")).toContain(
			"form-action 'self' https://connect.composio.dev https://dashboard.composio.dev",
		)
		const html = await chrome.text()
		expect(html).toContain("1 connection to configure")
		expect(html.match(/agent: daily-summary/g)).toHaveLength(2)
		expect(html).not.toContain("Used by")
		expect(html.match(/Configure accounts for mail/g)).toHaveLength(1)
		expect(html.match(/Configure accounts for repository/g)).toHaveLength(1)
		for (const name of ["MODEL_KEY", "PERSONAL_KEY", "priorities", "reports"])
			expect(html).not.toContain(name)
		const chromeAssigned = await fetch(chromeUrl, {
			body: new URLSearchParams({
				connection_id: mailAccount.id,
				intent: "assign",
				slug: "mail",
			}),
			headers: chromeHeaders,
			method: "POST",
		})
		expect(chromeAssigned.status).toBe(200)
		expect(await chromeAssigned.text()).toContain("all connections configured")
		const saved = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(saved.status).toBe(200)
		expect(
			appResourcesSchema.parse(await saved.json()).resources.connections.mail
				?.connection_id,
		).toBe(mailAccount.id)
		if (app === personal) {
			await db
				.updateTable("app")
				.set({ owner_user_id: publicViewer.owner_user_id, visibility: "public" })
				.where("id", "=", app.id)
				.execute()
			const viewerChrome = await fetch(chromeUrl, { headers: chromeHeaders })
			expect(viewerChrome.status).toBe(200)
			expect(await viewerChrome.text()).toContain("Managed by app owner")
			const denied = await fetch(chromeUrl, {
				body: new URLSearchParams({
					connection_id: mailAccount.id,
					intent: "assign",
					slug: "repository",
				}),
				headers: chromeHeaders,
				method: "POST",
			})
			expect(denied.status).toBe(403)
			await db
				.updateTable("app")
				.set({ owner_user_id: user.id, visibility: "private" })
				.where("id", "=", app.id)
				.execute()
		}
	}
	await writeFile(
		agentSlate,
		JSON.stringify({
			connections: { calendar: { mode: "viewer", toolkit: "googlecalendar" } },
		}),
	)
	const updated = await command("connections", "local", "list")
	expect(updated.stdout).toContain("calendar")
	expect(updated.stdout).not.toContain("repository")
	for (const app of [personal, organization]) {
		const pushed = await fetch(`${origin}/api/apps/${app.id}/resources/list`, post({}))
		expect(pushed.status).toBe(200)
		const { resources } = appResourcesSchema.parse(await pushed.json())
		expect(resources.connections.repository?.connection_id).toBe("test-repository")
		expect(resources.connections.calendar).toBeUndefined()
		expect(
			(
				await fetch(
					`${origin}/api/apps/${app.id}/resources/list`,
					post({ resources: collectAppResources(declarations) }),
				)
			).status,
		).toBe(400)
	}
	const resources = { connections: {}, databases: {}, secrets: {} }
	expect(
		(
			await fetch(
				`${origin}/api/apps/${publicViewer.id}/resources/list`,
				post({ resources }),
			)
		).status,
	).toBe(400)
	const openapi = await fetch(`${origin}/api/openapi.json`)
	expect(await openapi.text()).toContain('"operationId":"listAppResources"')
	expect(
		(
			await fetch(
				`${origin}/api/apps/${publicViewer.id}/connections/list`,
				post({ resources }),
			)
		).status,
	).toBe(400)
	expect(
		(
			await fetch(
				`${origin}/api/apps/${personal.id}/connections/list`,
				post({ manifest: { connections: {} } }),
			)
		).status,
	).toBe(400)
})
