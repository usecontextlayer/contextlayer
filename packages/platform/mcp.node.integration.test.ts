import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { betterAuth } from "better-auth"
import { toNodeHandler } from "better-auth/node"
import { bearer, jwt } from "better-auth/plugins"
import { expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"

test("native dispatcher and platform bind MCP to the app and reject cookie fallback", async () => {
	const server = createServer()
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`
	const auth = betterAuth({
		baseURL: issuer,
		emailAndPassword: { enabled: true },
		plugins: [bearer(), jwt()],
		secret: crypto.randomUUID(),
	})
	server.on("request", toNodeHandler(auth))
	const signedIn = await auth.api.signUpEmail({
		body: {
			email: "clock@example.com",
			name: "Clock owner",
			password: "clock-test-password",
		},
	})
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_mcp_auth_test: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_mcp_auth_test)
	const directory = await mkdtemp(join(tmpdir(), "ctx-mcp-auth-"))
	const platformConfig = join(directory, "platform.json")
	const dispatcherConfig = join(directory, "dispatcher.json")
	await writeFile(
		platformConfig,
		JSON.stringify({
			compatibility_date: "2026-10-02",
			compatibility_flags: ["nodejs_compat"],
			main: fileURLToPath(new URL("./build/server/index.js", import.meta.url)),
			name: "ctx-mcp-auth-platform",
			no_bundle: true,
		}),
	)
	const platform = createTestHarness({
		workers: [
			{
				configPath: platformConfig,
				secrets: {
					COMPOSIO_API_KEY: "unused",
					CTX_AUTH_ISSUER: issuer,
					CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_mcp_auth_test,
					POLAR_ACCESS_TOKEN: "unused",
					POLAR_ENVIRONMENT: "sandbox",
					POLAR_WEBHOOK_SECRET: "unused",
				},
			},
		],
	})
	let dispatcher: ReturnType<typeof createTestHarness> | undefined
	try {
		const app = await db
			.insertInto("app")
			.values({
				owner_user_id: signedIn.user.id,
				public_hostname: "clock.contextlayer.xyz",
				visibility: "private",
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		const resource = "https://clock.contextlayer.xyz/mcp"
		const { token } = await auth.api.signJWT({
			body: {
				overrideOptions: { jwt: { audience: resource, issuer } },
				payload: { scope: "ctx:mcp", sub: signedIn.user.id },
			},
		})
		const { url } = await platform.listen()
		await writeFile(
			dispatcherConfig,
			JSON.stringify({
				compatibility_date: "2026-10-02",
				compatibility_flags: ["nodejs_compat"],
				main: fileURLToPath(new URL("../dispatcher/index.ts", import.meta.url)),
				name: "ctx-mcp-auth-dispatcher",
				vars: { CTX_PLATFORM_URL: url.href },
			}),
		)
		dispatcher = createTestHarness({
			workers: [
				{
					configPath: dispatcherConfig,
					secrets: { POLAR_ACCESS_TOKEN: "unused", POLAR_ENVIRONMENT: "sandbox" },
				},
			],
		})
		await dispatcher.listen()
		const worker = dispatcher.getWorker()
		const metadata = await worker.fetch(
			"https://clock.contextlayer.xyz/.well-known/oauth-protected-resource/mcp",
		)
		expect(metadata.status).toBe(200)
		expect(await metadata.json()).toMatchObject({
			authorization_servers: [issuer],
			resource,
			scopes_supported: ["ctx:mcp"],
		})
		const cookie = `ctx-viewer-auth=${signedIn.token}`
		const challenge = await worker.fetch(resource, { headers: { cookie } })
		expect(challenge.status).toBe(401)
		expect(challenge.headers.get("www-authenticate")).toContain(
			'resource_metadata="https://clock.contextlayer.xyz/.well-known/oauth-protected-resource/mcp"',
		)
		expect(challenge.headers.get("location")).toBeNull()
		const headers = { authorization: `Bearer ${token}` }
		// Identity and private viewing succeed; this fixture has no subscription state.
		expect((await worker.fetch(resource, { headers })).status).toBe(402)
		const other = await db
			.insertInto("app")
			.values({
				owner_user_id: signedIn.user.id,
				public_hostname: "other.contextlayer.xyz",
				visibility: "private",
			})
			.returningAll()
			.executeTakeFirstOrThrow()
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
	} finally {
		await dispatcher?.close()
		await platform.close()
		await db.destroy()
		await databases.dropAll()
		await rm(directory, { force: true, recursive: true })
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
		})
	}
})
