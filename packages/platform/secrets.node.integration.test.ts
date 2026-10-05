import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { afterAll, beforeAll, expect, test } from "vitest"
import { z } from "zod"
import { organizationSchema } from "@/auth.server"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv, parseSharedSecretsEnv } from "@/env"
import type { Owner } from "@/owner"
import { secretKey } from "@/secrets.server"
import { startPlatformWorker } from "@/testing"

const cli = join(import.meta.dirname, "../cli/dist/cli.mjs")
let origin: string
let userId: string
let headers: { authorization: string }
let config: ReturnType<typeof parsePlatformEnv>
let databases: Awaited<ReturnType<typeof provisionEphemeralDatabases>>
let dir: string
let worker: Awaited<ReturnType<typeof startPlatformWorker>>

beforeAll(async () => {
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_secrets_test: migrateToLatest },
	})
	config = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_secrets_test,
	})
	headers = {
		authorization: `Bearer ${z.string().min(1).parse(process.env.CTX_TEST_ACCESS_TOKEN)}`,
	}
	dir = await mkdtemp(join(tmpdir(), "ctx-secrets-"))
	worker = await startPlatformWorker(config, dir, process.env)
	origin = await worker.ready
	const response = await fetch(`${origin}/api/me`, { headers })
	expect(response.status).toBe(200)
	userId = z.object({ id: z.string() }).parse(await response.json()).id
})

afterAll(async () => {
	worker?.server.kill("SIGTERM")
	if (worker) await worker.exited
	if (dir) await rm(dir, { force: true, recursive: true })
	if (databases) await databases.dropAll()
})

async function runCli(args: string[], input?: string) {
	const child = spawn(process.execPath, [cli, ...args], {
		env: { ...process.env, CTX_PLATFORM_URL: origin },
		stdio: ["pipe", "pipe", "pipe"],
	})
	const exited = once(child, "close")
	let output = ""
	const collect = (chunk: Buffer) => {
		output += chunk.toString()
	}
	child.stdout.on("data", collect)
	child.stderr.on("data", collect)
	child.stdin.end(input)
	const [code] = await exited
	return { code, output }
}

test("non-writing: secret API requires authentication and the selected Owner", async () => {
	const name = "CTX_SECRET_ACCESS_TEST"
	for (const method of ["PUT", "DELETE"]) {
		const request =
			method === "PUT"
				? {
						body: JSON.stringify({ value: "test-only-value" }),
						headers: { "content-type": "application/json" },
						method,
					}
				: { method }
		expect(
			(await fetch(`${origin}/api/secrets/user/${userId}/${name}`, request)).status,
		).toBe(401)
		for (const type of ["user", "org"]) {
			expect(
				(
					await fetch(`${origin}/api/secrets/${type}/not-this-owner/${name}`, {
						...request,
						headers: { ...request.headers, ...headers },
					})
				).status,
			).toBe(403)
		}
	}
	const schema = z
		.object({
			paths: z.object({
				"/secrets/{type}/{owner_id}/{name}": z.object({
					delete: z.object({ operationId: z.string() }),
					put: z.object({ operationId: z.string() }),
				}),
			}),
		})
		.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
	expect(schema.paths["/secrets/{type}/{owner_id}/{name}"].put.operationId).toBe(
		"setSharedSecret",
	)
	expect(schema.paths["/secrets/{type}/{owner_id}/{name}"].delete.operationId).toBe(
		"dropSharedSecret",
	)
	expect(
		(await fetch(`${origin}/api/secrets/user/${userId}/${name}`, { headers })).status,
	).toBe(404)
})

test("non-writing: CLI requires explicit stdin input and resolves organization membership", async () => {
	const nonTerminal = await runCli(["secrets", "set", "CTX_SECRET_ACCESS_TEST"])
	expect(nonTerminal.code).toBe(1)
	expect(nonTerminal.output).toContain("Use --stdin")
	const unknownOrg = await runCli([
		"secrets",
		"--org",
		"not-a-member",
		"drop",
		"CTX_SECRET_ACCESS_TEST",
	])
	expect(unknownOrg.code).toBe(1)
	expect(unknownOrg.output).toContain("Organization is not in your memberships")
})

test("live Doppler: CLI/API save, replace, isolate Owners, and drop with no values in output", async () => {
	const vaultConfig = parseSharedSecretsEnv(config)
	const name = z
		.string()
		.regex(/^CTX_SECRET_E2E_[A-Z0-9_]+$/)
		.parse(process.env.CTX_TEST_SECRET_NAME)
	const slug = z.string().min(1).parse(process.env.CTX_TEST_ORGANIZATION_SLUG)
	const organizationUrl = new URL("/api/platform/organizations", config.CTX_AUTH_ISSUER)
	const response = await fetch(organizationUrl, { headers })
	expect(response.status).toBe(200)
	const { organizations } = z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await response.json())
	const organization = organizationSchema.parse(
		organizations.find((organization) => organization.slug === slug),
	)
	const orgId = organization.id
	const providerHeaders = {
		authorization: `Bearer ${vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN}`,
	}
	const providerUrl = (owner: Owner) => {
		const url = new URL("https://api.doppler.com/v3/configs/config/secret")
		url.search = new URLSearchParams({
			config: vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG,
			name: secretKey(owner, name),
			project: vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT,
		}).toString()
		return url
	}
	const personalUrl = providerUrl({ id: userId, type: "user" })
	const orgUrl = providerUrl({ id: orgId, type: "organization" })
	const readRaw = async (url: URL) => {
		const read = await fetch(url, { headers: providerHeaders })
		expect(read.status).toBe(200)
		return z
			.object({ value: z.object({ raw: z.string().nullable() }) })
			.parse(await read.json()).value.raw
	}
	const assertRawValue = async (url: URL, value: string | null) => {
		// Boolean assertions keep provider plaintext out of failure diagnostics.
		expect((await readRaw(url)) === value).toBe(true)
	}
	// Existing secrets are not disposable fixtures; refuse to overwrite them for this proof.
	for (const url of [personalUrl, orgUrl]) await assertRawValue(url, null)
	const values = [
		`  synthetic-personal-\${DOPPLER_PROJECT}\nsecond line  `,
		"synthetic-organization",
		"synthetic-personal-replaced",
		"synthetic-organization-replaced",
	] as const
	const assertCli = (result: Awaited<ReturnType<typeof runCli>>, owner: Owner) => {
		expect(result.code).toBe(0)
		for (const value of values) expect(result.output.includes(value)).toBe(false)
		expect(JSON.parse(result.output)).toEqual({ name, owner })
	}
	assertCli(await runCli(["secrets", "set", name, "--stdin"], values[0]), {
		id: userId,
		type: "user",
	})
	await assertRawValue(personalUrl, values[0])
	const personalApi = `${origin}/api/secrets/user/${encodeURIComponent(userId)}/${name}`
	expect((await fetch(personalApi, { headers })).status).toBe(404)
	assertCli(await runCli(["secrets", "--org", slug, "set", name, "--stdin"], values[1]), {
		id: orgId,
		type: "organization",
	})
	await assertRawValue(orgUrl, values[1])
	await assertRawValue(personalUrl, values[0])
	const replaced = await fetch(personalApi, {
		body: JSON.stringify({ value: values[2] }),
		headers: { ...headers, "content-type": "application/json" },
		method: "PUT",
	})
	expect(replaced.status).toBe(200)
	expect(await replaced.json()).toEqual({ name, owner: { id: userId, type: "user" } })
	await assertRawValue(personalUrl, values[2])
	await assertRawValue(orgUrl, values[1])
	assertCli(await runCli(["secrets", "--org", slug, "set", name, "--stdin"], values[3]), {
		id: orgId,
		type: "organization",
	})
	await assertRawValue(orgUrl, values[3])
	await assertRawValue(personalUrl, values[2])
	assertCli(await runCli(["secrets", "drop", name]), { id: userId, type: "user" })
	await assertRawValue(personalUrl, null)
	await assertRawValue(orgUrl, values[3])
	const dropped = await fetch(
		`${origin}/api/secrets/org/${encodeURIComponent(orgId)}/${name}`,
		{ headers, method: "DELETE" },
	)
	expect(dropped.status).toBe(200)
	expect(await dropped.json()).toEqual({
		name,
		owner: { id: orgId, type: "organization" },
	})
	await assertRawValue(orgUrl, null)
	for (const value of values) {
		expect(worker.output.includes(value)).toBe(false)
		expect(worker.output.includes(JSON.stringify(value).slice(1, -1))).toBe(false)
	}
	expect(worker.output.includes(vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN)).toBe(
		false,
	)
	expect(worker.output.includes(headers.authorization)).toBe(false)
})
