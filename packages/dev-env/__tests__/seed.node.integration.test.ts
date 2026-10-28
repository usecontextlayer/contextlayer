import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execa } from "execa"
import postgres from "postgres"
import { expect, test } from "vitest"
import { provisionEphemeralDatabases, seedDatabase } from "@/database"
import { readDevEnvServiceEnv, readDevEnvWebEnv } from "@/dev-env"
import { readDevEnv } from "@/env"
import { assignDevEnvPorts } from "@/ports"
import seed from "@/seed.json" with { type: "json" }
import { startNext } from "@/services"
import { signInWeb } from "@/web"

const root = resolve(import.meta.dirname, "../../..")
const webRoot = resolve(root, "../web")

test("the SQL fixture supports native login and OAuth in independent web databases", async () => {
	await using resources = new AsyncDisposableStack()
	const directory = await mkdtemp(join(tmpdir(), "dev-env-seed-"))
	resources.defer(() => rm(directory, { force: true, recursive: true }))
	const initial = readDevEnv()
	const settings = await readDevEnvServiceEnv(
		root,
		await readDevEnvWebEnv(webRoot, initial),
		initial,
	)
	const databases = await provisionEphemeralDatabases(initial.DATABASE_URL, {
		baseNames: ["ctx_seed_web_a", "ctx_seed_web_b"],
		async migrate(urls) {
			for (const DATABASE_URL of Object.values(urls))
				await execa("pnpm", ["db.latest", "--ci"], {
					cwd: webRoot,
					env: { ...settings.webEnv, DATABASE_URL, NODE_ENV: "development" },
					stdio: "inherit",
				})
		},
	})
	resources.defer(databases.dropAll)
	const template = await readFile(resolve(webRoot, "database/dev-seed.sql"), "utf8")
	const sessions = []
	for (const [name, DATABASE_URL] of Object.entries(databases.urls)) {
		await seedDatabase(DATABASE_URL, template, seed)
		await seedDatabase(DATABASE_URL, template, seed)
		const db = postgres(DATABASE_URL, { max: 1 })
		resources.defer(() => db.end())
		expect(await db`select count(*)::int as count from "user"`).toEqual([{ count: 1 }])
		expect(await db`select count(*)::int as count from member`).toEqual([{ count: 1 }])
		expect(await db`select count(*)::int as count from "oauthClientResource"`).toEqual([
			{ count: 1 },
		])
		const addresses = await assignDevEnvPorts(join(directory, name))
		const web = startNext({
			cwd: webRoot,
			env: {
				...settings.webEnv,
				BETTER_AUTH_URL: addresses.BETTER_AUTH_URL.href,
				CTX_PLATFORM_URL: addresses.CTX_PLATFORM_URL.href,
				CTX_VIEWER_AUTH_URL: addresses.CTX_VIEWER_AUTH_URL.href,
				DATABASE_URL,
				NODE_ENV: "development",
			},
			url: addresses.BETTER_AUTH_URL,
		})
		resources.defer(async () => {
			web.process.kill("SIGTERM")
			try {
				await web.process
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!("signal" in error) ||
					error.signal !== "SIGTERM"
				)
					throw error
			}
		})
		await web.ready
		const session = await signInWeb({
			baseURL: web.url.href,
			email: seed.web.user.email,
			password: seed.web.credentials.password,
		})
		resources.defer(async () => {
			await session.client.signOut()
		})
		expect(session.user.id).toBe(seed.web.user.id)
		const organizations = await fetch(new URL("/api/auth/organization/list", web.url), {
			headers: session.headers,
		})
		expect(organizations.status).toBe(200)
		expect(await organizations.json()).toMatchObject([{ id: seed.web.organization.id }])
		const device = await fetch(new URL("/api/auth/device/code", web.url), {
			body: new URLSearchParams({
				client_id: seed.web.client.clientId,
				resource: seed.web.resource.identifier,
				scope: seed.web.client.scopes.join(" "),
			}),
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		expect(device.status).toBe(200)
		expect(await device.json()).toMatchObject({ device_code: expect.any(String) })
		sessions.push({ ...session, url: web.url })
	}
	const [first, second] = sessions
	if (!first || !second) throw new Error("Expected both web sessions")
	const own = await fetch(new URL("/api/auth/get-session", second.url), {
		headers: second.headers,
	})
	expect(await own.json()).toMatchObject({ user: { id: seed.web.user.id } })
	const other = await fetch(new URL("/api/auth/get-session", second.url), {
		headers: first.headers,
	})
	expect(await other.json()).toBeNull()
}, 180_000)
