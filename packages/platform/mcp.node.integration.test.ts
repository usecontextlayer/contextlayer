import { execFile as execFileCallback } from "node:child_process"
import { once } from "node:events"
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { getSubscriptions } from "@polar-sh/sdk/2026-10/services/subscriptions"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { betterAuth } from "better-auth"
import { toNodeHandler } from "better-auth/node"
import { bearer, jwt } from "better-auth/plugins"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createTestHarness, unstable_readConfig } from "wrangler"
import { z } from "zod"
import { saveCustomerState } from "@/billing.server"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const execFile = promisify(execFileCallback)
const server = createServer()
const platform = createTestHarness()
const dispatcher = createTestHarness()
const wrangler = fileURLToPath(
	new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url),
)
let auth: ReturnType<typeof createAuth>
let issuer: string
let origin: string
let userId: string
let cookie: string
let databases: ProvisionedDatabases<"ctx_mcp_auth_test">
let db: ReturnType<typeof createPlatformDb>
let app: Awaited<ReturnType<typeof insertApp>>

function createAuth(baseURL: string) {
	return betterAuth({
		baseURL,
		emailAndPassword: { enabled: true },
		plugins: [bearer(), jwt()],
		secret: crypto.randomUUID(),
	})
}

function insertApp(ownerId: string) {
	return db
		.insertInto("app")
		.values({
			owner_user_id: ownerId,
			public_hostname: `${crypto.randomUUID()}.contextlayer.xyz`,
			visibility: "private",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
}

function signMcpToken(subject: string, hostname: string) {
	return auth.api.signJWT({
		body: {
			overrideOptions: { jwt: { audience: `https://${hostname}/mcp`, issuer } },
			payload: { scope: "ctx:mcp", sub: subject },
		},
	})
}

beforeAll(async () => {
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`
	auth = createAuth(issuer)
	server.on("request", toNodeHandler(auth))
	const signedIn = await auth.api.signUpEmail({
		body: {
			email: "clock@example.com",
			name: "Clock owner",
			password: "clock-test-password",
		},
	})
	userId = signedIn.user.id
	cookie = `ctx-viewer-auth=${signedIn.token}`
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_mcp_auth_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_mcp_auth_test)
	app = await insertApp(userId)
	await platform.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: parsePlatformEnv({
					COMPOSIO_API_KEY: "unused",
					CTX_AUTH_ISSUER: issuer,
					CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG: "unused",
					CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT: "unused",
					CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN: "unused",
					CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_mcp_auth_test,
					POLAR_ACCESS_TOKEN: "unused",
					POLAR_ENVIRONMENT: "sandbox",
					POLAR_WEBHOOK_SECRET: "unused",
				}),
			},
		],
	})
	origin = (await platform.listen()).url.origin
	await dispatcher.update({
		workers: [
			{
				configPath: new URL("../dispatcher/wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("../dispatcher/dist", import.meta.url),
				secrets: { POLAR_ACCESS_TOKEN: "unused", POLAR_ENVIRONMENT: "sandbox" },
				vars: { CTX_PLATFORM_URL: origin },
			},
		],
	})
	await dispatcher.listen()
})

afterAll(async () => {
	await dispatcher.close()
	await platform.close()
	await server[Symbol.asyncDispose]()
	await db?.destroy()
	await databases?.dropAll()
})

test("native dispatcher and platform bind MCP to the app and reject cookie fallback", async () => {
	const worker = dispatcher.getWorker()
	const resource = `https://${app.public_hostname}/mcp`
	const metadataUrl = `https://${app.public_hostname}/.well-known/oauth-protected-resource/mcp`
	const metadata = await worker.fetch(metadataUrl)
	expect(metadata.status).toBe(200)
	expect(await metadata.json()).toMatchObject({
		authorization_servers: [issuer],
		resource,
		scopes_supported: ["ctx:mcp"],
	})
	const challenge = await worker.fetch(resource, { headers: { cookie } })
	expect(challenge.status).toBe(401)
	expect(challenge.headers.get("www-authenticate")).toContain(
		`resource_metadata="${metadataUrl}"`,
	)
	expect(challenge.headers.get("location")).toBeNull()
	const { token } = await signMcpToken(userId, app.public_hostname)
	const headers = { authorization: `Bearer ${token}` }
	// Identity and private viewing succeed; this fixture has no subscription state.
	expect((await worker.fetch(resource, { headers })).status).toBe(402)
	const other = await insertApp(userId)
	expect(
		(await worker.fetch(`https://${other.public_hostname}/mcp`, { headers })).status,
	).toBe(401)
	const nativePlatform = platform.getWorker()
	expect((await nativePlatform.fetch("/api/apps", { headers })).status).toBe(401)
	expect(
		(
			await nativePlatform.fetch(
				`/api/apps/resolve?hostname=${app.public_hostname}&pathname=/slate.json`,
				{ headers: { cookie } },
			)
		).status,
	).toBe(200)
})

describe("authored MCP protocol and usage", () => {
	const client = new Client({ name: "native-mcp-integration", version: "1" })
	let directory: string
	let echoApp: typeof app
	let deployed = false
	let polar: ReturnType<typeof createPolarCore>
	let ownerId: string
	let namespace: string
	let accountId: string

	beforeAll(async () => {
		const config = z
			.object({
				CTX_TEST_POLAR_USER_SUBSCRIPTION_ID: z.uuid(),
				POLAR_ACCESS_TOKEN: z.string().min(1),
				POLAR_ENVIRONMENT: z.literal("sandbox"),
			})
			.parse(process.env)
		polar = createPolarCore({
			accessToken: config.POLAR_ACCESS_TOKEN,
			environment: config.POLAR_ENVIRONMENT,
		})
		const subscription = await getSubscriptions(polar)(
			config.CTX_TEST_POLAR_USER_SUBSCRIPTION_ID,
		)
		ownerId = z.string().min(1).parse(subscription.customer.external_id)
		const state = await getStateExternalCustomers(polar)(ownerId)
		expect(state.active_subscriptions.map((active) => active.id)).toContain(
			config.CTX_TEST_POLAR_USER_SUBSCRIPTION_ID,
		)
		await saveCustomerState(db, state, null)
		echoApp = await insertApp(ownerId)
		directory = await mkdtemp(join(tmpdir(), "ctx-mcp-protocol-"))
		await cp(new URL("./fixtures/mcp", import.meta.url), directory, { recursive: true })
		await cp(
			new URL("../cli/template/workers/local-resources", import.meta.url),
			join(directory, "workers/local-resources"),
			{ recursive: true },
		)
		await symlink(
			fileURLToPath(new URL("./node_modules", import.meta.url)),
			join(directory, "node_modules"),
			"dir",
		)
		const nativeConfig = unstable_readConfig({
			config: fileURLToPath(new URL("../dispatcher/wrangler.jsonc", import.meta.url)),
			env: "test",
		})
		accountId = z.string().parse(nativeConfig.account_id)
		namespace = z.string().parse(nativeConfig.dispatch_namespaces[0]?.namespace)
		const workerConfig = join(directory, "wrangler.jsonc")
		await writeFile(
			workerConfig,
			JSON.stringify({
				account_id: accountId,
				compatibility_date: "2026-10-02",
				main: "./workers/app.ts",
				name: echoApp.id,
			}),
		)
		await execFile(
			process.execPath,
			[
				fileURLToPath(new URL("./node_modules/vite/bin/vite.js", import.meta.url)),
				"build",
			],
			{ cwd: directory },
		)
		await execFile(
			process.execPath,
			[
				wrangler,
				"deploy",
				"--config",
				join(directory, "build/server/wrangler.json"),
				"--dispatch-namespace",
				namespace,
				"--env=",
			],
			{ cwd: directory },
		)
		deployed = true
		console.info("Native MCP fixture", { appId: echoApp.id, namespace, ownerId })
		await dispatcher.update({
			workers: [
				{
					configPath: new URL("../dispatcher/wrangler.jsonc", import.meta.url),
					env: "test",
					prebuiltWorkerDir: new URL("../dispatcher/dist", import.meta.url),
					secrets: {
						POLAR_ACCESS_TOKEN: config.POLAR_ACCESS_TOKEN,
						POLAR_ENVIRONMENT: config.POLAR_ENVIRONMENT,
					},
					vars: { CTX_PLATFORM_URL: origin },
				},
			],
		})
		const { token } = await signMcpToken(ownerId, echoApp.public_hostname)
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL(`https://${echoApp.public_hostname}/mcp`),
				{
					fetch: dispatcher
						.getWorker()
						.fetch.bind(dispatcher.getWorker()) as unknown as typeof fetch,
					requestInit: { headers: { authorization: `Bearer ${token}` } },
				},
			),
		)
	})

	afterAll(async () => {
		try {
			await client.close()
			if (deployed) {
				await execFile(
					"npx",
					[
						"--yes",
						"cf",
						"workers-for-platforms",
						"dispatch-namespaces",
						"scripts",
						"delete",
						echoApp.id,
						"--dispatch-namespace",
						namespace,
						"--force",
					],
					{
						cwd: directory,
						env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
					},
				)
			}
		} finally {
			if (directory) await rm(directory, { force: true, recursive: true })
		}
	})

	test("discovers a View and invokes an authored Worker once through native MCP", async () => {
		const tools = await client.listTools()
		expect(tools.tools).toMatchObject([
			{ _meta: { ui: { resourceUri: "ui://echo/index.html" } }, name: "echo" },
		])
		const view = await client.readResource({ uri: "ui://echo/index.html" })
		expect(view.contents).toMatchObject([
			{
				mimeType: "text/html;profile=mcp-app",
				text: expect.stringContaining("Echo View"),
			},
		])
		const valid = await client.callTool({ arguments: { value: 42 }, name: "echo" })
		expect(valid.structuredContent).toEqual({
			authorization: null,
			runtime: expect.stringContaining("Cloudflare-Workers"),
			value: 42,
		})
		const invalid = await client.callTool({
			arguments: { value: "wrong type" },
			name: "echo",
		})
		expect(invalid.isError).toBe(true)
		await expect
			.poll(
				async () => {
					const events = await listEvents(polar)({
						external_customer_id: ownerId,
						metadata: { user_code_worker_id: echoApp.id },
					})
					return events.items
						.filter((event) => event.source === "user")
						.map((event) => ({ clips: event.metadata.clips, name: event.name }))
				},
				{ interval: 1000, timeout: 60_000 },
			)
			.toEqual([{ clips: 1, name: "tool_call" }])
	})
})
