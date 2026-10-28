import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execa } from "execa"
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

test("seeding independent web databases supports native auth and preserves sessions on rerun", async () => {
	await using resources = new AsyncDisposableStack()
	const directory = await mkdtemp(join(tmpdir(), "dev-env-seed-"))
	resources.defer(() => rm(directory, { force: true, recursive: true }))
	const initial = readDevEnv()
	const databases = await provisionEphemeralDatabases(initial.DATABASE_URL, {
		baseNames: ["ctx_seed_web_a", "ctx_seed_web_b"],
		async migrate(urls) {
			for (const DATABASE_URL of Object.values(urls))
				await execa("pnpm", ["db.latest", "--ci"], {
					cwd: webRoot,
					env: { DATABASE_URL, NODE_ENV: "development" },
					stdio: "inherit",
				})
		},
	})
	resources.defer(databases.dropAll)
	const template = await readFile(resolve(webRoot, "database/dev-seed.sql"), "utf8")
	const sessions = []
	for (const [name, DATABASE_URL] of Object.entries(databases.urls)) {
		await seedDatabase(DATABASE_URL, template, seed)
		const addresses = {
			...(await assignDevEnvPorts(join(directory, name))),
			DATABASE_URL,
		}
		const settings = await readDevEnvServiceEnv(
			root,
			await readDevEnvWebEnv(webRoot, addresses),
			addresses,
		)
		const web = startNext({
			cwd: webRoot,
			env: {
				...settings.webEnv,
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
		await seedDatabase(DATABASE_URL, template, seed)
		const preserved = await fetch(new URL("/api/auth/get-session", web.url), {
			headers: session.headers,
		})
		expect(preserved.status).toBe(200)
		expect(await preserved.json()).toMatchObject({ user: { id: seed.web.user.id } })
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
	const other = await fetch(new URL("/api/auth/get-session", second.url), {
		headers: first.headers,
	})
	expect(other.status).toBe(200)
	expect(await other.json()).toBeNull()
}, 180_000)
