import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { type App, appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import { toolResultSchema } from "@/tools.schema"

const execFile = promisify(execFileCallback)
const configSchema = z.object({
	CTX_TEST_ACCESS_TOKEN: z.string().min(1),
	CTX_TEST_CONNECTION_EMAIL: z.email(),
	CTX_TEST_CONNECTION_ID: z.string().min(1),
	CTX_TEST_ORGANIZATION_ID: z.string().min(1),
	CTX_TEST_ORGANIZATION_SLUG: z.string().min(1),
	CTX_TEST_POLAR_ORGANIZATION_SUBSCRIPTION_ID: z.uuid(),
	CTX_TEST_POLAR_USER_SUBSCRIPTION_ID: z.uuid(),
	CTX_TEST_USER_ID: z.string().min(1),
	POLAR_ENVIRONMENT: z.literal("sandbox"),
})
const platform = createTestHarness()
const dispatcher = createTestHarness()
const apps: App[] = []
const deployed: string[] = []
let config: z.infer<typeof configSchema>
let env: ReturnType<typeof parsePlatformEnv>
let databases: ProvisionedDatabases<"ctx_usage_test">
let db: ReturnType<typeof createPlatformDb>
let polar: ReturnType<typeof createPolarCore>
let dir: string
let origin: string
let namespace: string
let accountId: string
let headers: { authorization: string }
const wrangler = new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url)

beforeAll(async () => {
	config = configSchema.parse(process.env)
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_usage_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_usage_test)
	env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_usage_test,
	})
	headers = { authorization: `Bearer ${config.CTX_TEST_ACCESS_TOKEN}` }
	polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: config.POLAR_ENVIRONMENT,
	})
	dir = await mkdtemp(join(tmpdir(), "ctx-usage-"))
	await platform.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: env,
			},
		],
	})
	origin = (await platform.listen()).url.origin
	const dispatchConfig = JSON.parse(
		await readFile(new URL("../dispatcher/wrangler.jsonc", import.meta.url), "utf8"),
	)
	accountId = z.string().parse(dispatchConfig.account_id)
	namespace = z.string().parse(dispatchConfig.env.test.dispatch_namespaces[0].namespace)
	await dispatcher.update({
		workers: [
			{
				configPath: new URL("../dispatcher/wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("../dispatcher/dist", import.meta.url),
				secrets: {
					POLAR_ACCESS_TOKEN: env.POLAR_ACCESS_TOKEN,
					POLAR_ENVIRONMENT: config.POLAR_ENVIRONMENT,
				},
				vars: { CTX_PLATFORM_URL: origin },
			},
		],
	})
	await dispatcher.listen()
	for (const [id, subscriptionId] of [
		[config.CTX_TEST_USER_ID, config.CTX_TEST_POLAR_USER_SUBSCRIPTION_ID],
		[config.CTX_TEST_ORGANIZATION_ID, config.CTX_TEST_POLAR_ORGANIZATION_SUBSCRIPTION_ID],
	] as const) {
		const state = await getStateExternalCustomers(polar)(id)
		expect(state.active_subscriptions.map((active) => active.id)).toContain(
			subscriptionId,
		)
		await saveCustomerState(db, state, null)
	}
})

afterAll(async () => {
	try {
		for (const id of deployed) {
			await execFile(
				"npx",
				[
					"--yes",
					"cf",
					"workers-for-platforms",
					"dispatch-namespaces",
					"scripts",
					"delete",
					id,
					"--dispatch-namespace",
					namespace,
					"--force",
				],
				{ cwd: dir, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } },
			)
		}
		for (const app of apps) {
			const { ARTIFACTS } = await platform.getWorker<PlatformEnv["Bindings"]>().getEnv()
			await ARTIFACTS.delete(app.id)
		}
	} finally {
		await dispatcher.close()
		await platform.close()
		if (dir) await rm(dir, { force: true, recursive: true })
		await db?.destroy()
		await databases?.dropAll()
	}
})

test("real dispatch and connected-account execution report exact app-owner usage", async () => {
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
	for (const [body, ownerId] of [
		[{}, config.CTX_TEST_USER_ID],
		[
			{ organization_slug: config.CTX_TEST_ORGANIZATION_SLUG },
			config.CTX_TEST_ORGANIZATION_ID,
		],
	] as const) {
		const created = await fetch(`${origin}/api/apps`, post(body))
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		apps.push(app)
		expect(app.owner_user_id ?? app.owner_organization_id).toBe(ownerId)
		const appDir = join(dir, app.id)
		await mkdir(join(appDir, "public"), { recursive: true })
		const slate = { connections: { mail: { mode: "viewer", toolkit: "gmail" } } }
		await writeFile(join(appDir, "public/slate.json"), JSON.stringify(slate))
		await writeFile(
			join(appDir, "index.js"),
			`export default {
			async fetch(request) {
				return Response.json({
					method: request.method,
					authorization: request.headers.get("authorization"),
					body: await request.text(),
				})
			}
		}`,
		)
		const workerConfig = join(appDir, "wrangler.json")
		await writeFile(
			workerConfig,
			JSON.stringify({
				account_id: accountId,
				compatibility_date: "2026-10-02",
				main: "index.js",
				name: app.id,
			}),
		)
		const gitEnv = {
			...process.env,
			CTX_AUTH_ISSUER: env.CTX_AUTH_ISSUER,
			CTX_PLATFORM_URL: origin,
			GIT_CONFIG_GLOBAL: join(appDir, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
		}
		const git = (...args: string[]) => execFile("git", args, { cwd: appDir, env: gitEnv })
		await git(
			"config",
			"--global",
			`credential.${origin}/git.helper`,
			`${cli} git-credential`,
		)
		await git("init", "-b", "main")
		await git("config", "user.name", "Usage Test")
		await git("config", "user.email", "usage-test@example.com")
		await git("remote", "add", "origin", `${origin}/git/${app.id}`)
		await git("add", "public", "index.js", "wrangler.json")
		await git("-c", "commit.gpgsign=false", "commit", "-m", "Declare usage test app")
		await git("push", "origin", "main")
		await execFile(
			process.execPath,
			[
				wrangler.pathname,
				"deploy",
				"--config",
				workerConfig,
				"--dispatch-namespace",
				namespace,
			],
			{ cwd: appDir },
		)
		deployed.push(app.id)
		const assigned = await fetch(
			`${origin}/api/apps/${app.id}/connections/assign`,
			post({
				connection_id: config.CTX_TEST_CONNECTION_ID,
				slug: "mail",
			}),
		)
		expect(assigned.status).toBe(200)
		for (const method of ["GET", "POST"]) {
			const response = await dispatcher
				.getWorker()
				.fetch(`https://${app.public_hostname}/`, {
					headers,
					method,
					...(method === "POST" ? { body: "usage test action" } : {}),
				})
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				authorization: null,
				body: method === "POST" ? "usage test action" : "",
				method,
			})
		}
		const execution = await fetch(
			`${origin}/api/apps/${app.id}/tools/call`,
			post({
				arguments: { user_id: "me" },
				slug: "mail",
				tool: "GMAIL_GET_PROFILE",
			}),
		)
		expect(execution.status).toBe(200)
		const result = toolResultSchema.parse(await execution.json())
		expect(result.error).toBeNull()
		expect(result.logId.length).toBeGreaterThan(0)
		expect(result.data).toMatchObject({ emailAddress: config.CTX_TEST_CONNECTION_EMAIL })
		await expect
			.poll(
				async () => {
					const events = await listEvents(polar)({
						external_customer_id: ownerId,
						metadata: { user_code_worker_id: app.id },
					})
					return events.items
						.filter((event) => event.source === "user")
						.map((event) => ({ clips: event.metadata.clips, name: event.name }))
						.sort((a, b) => a.name.localeCompare(b.name))
				},
				{ interval: 1000, timeout: 60_000 },
			)
			.toEqual([
				{ clips: 3, name: "action_call" },
				{ clips: 1, name: "loader_call" },
				{ clips: 1, name: "tool_call" },
			])
	}
}, 180_000)
