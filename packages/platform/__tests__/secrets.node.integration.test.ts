import { join } from "node:path"
import { test as base } from "@tests/integration"
import { execa } from "execa"
import { expect } from "vitest"
import { z } from "zod"
import { connectionsSchema } from "@/connections.schema"
import { parseSharedSecretsEnv } from "@/env"
import type { Owner } from "@/owner"
import { secretKey } from "@/secrets.server"

const cli = join(import.meta.dirname, "../../cli/dist/cli.mjs")
const test = base.extend(
	"runCli",
	({ cliEnv }) =>
		(args: string[], input = "") =>
			execa(process.execPath, [cli, ...args], {
				all: true,
				env: cliEnv,
				input,
				reject: false,
			}),
)

test("non-writing: secret API requires authentication and the selected Owner", async ({
	identity,
	platform,
}) => {
	const {
		headers,
		user: { id: userId },
	} = identity
	const { origin } = platform
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

test("non-writing: CLI requires explicit stdin input and resolves organization membership", async ({
	runCli,
}) => {
	const nonTerminal = await runCli(["secrets", "set", "CTX_SECRET_ACCESS_TEST"])
	expect(nonTerminal.exitCode).toBe(1)
	expect(nonTerminal.all).toContain("Use --stdin")
	const unknownOrg = await runCli([
		"secrets",
		"--org",
		"not-a-member",
		"drop",
		"CTX_SECRET_ACCESS_TEST",
	])
	expect(unknownOrg.exitCode).toBe(1)
	expect(unknownOrg.all).toContain("Organization is not in your memberships")
})

test("non-writing: Owner connections enforce access and list through the real API and CLI", async ({
	identity,
	organization,
	platform,
	runCli,
}) => {
	const {
		headers,
		user: { id: userId },
	} = identity
	const { origin } = platform
	const { slug } = organization
	const personalUrl = `${origin}/api/connections/user/${encodeURIComponent(userId)}`
	for (const method of ["GET", "POST"]) {
		const request =
			method === "POST"
				? {
						body: JSON.stringify({ toolkit: "gmail" }),
						headers: { "content-type": "application/json" },
						method,
					}
				: { method }
		expect((await fetch(personalUrl, request)).status).toBe(401)
		for (const type of ["user", "org"]) {
			expect(
				(
					await fetch(`${origin}/api/connections/${type}/not-this-owner`, {
						...request,
						headers: { ...request.headers, ...headers },
					})
				).status,
			).toBe(403)
		}
	}
	for (const [url, args] of [
		[personalUrl, ["connections", "list"]],
		[
			`${origin}/api/connections/org/${encodeURIComponent(organization.id)}`,
			["connections", "--org", slug, "list"],
		],
	] as const) {
		const response = await fetch(url, { headers })
		expect(response.status).toBe(200)
		const { connections } = connectionsSchema.parse(await response.json())
		const cli = await runCli([...args])
		expect(cli.exitCode).toBe(0)
		if (connections.length === 0) expect(cli.all).toContain("No connected accounts.")
		for (const account of connections) expect(cli.all).toContain(account.id)
	}
	const unknownOrg = await runCli(["connections", "--org", "not-a-member", "list"])
	expect(unknownOrg.exitCode).toBe(1)
	expect(unknownOrg.all).toContain("Organization is not in your memberships")
	const { paths } = z
		.object({
			paths: z.record(
				z.string(),
				z.object({ get: z.unknown().optional(), post: z.unknown().optional() }),
			),
		})
		.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
	expect(paths["/connections/{type}/{owner_id}"]).toEqual(
		expect.objectContaining({
			get: expect.objectContaining({ operationId: "listConnections" }),
			post: expect.objectContaining({ operationId: "authorizeConnection" }),
		}),
	)
	expect(paths["/connections"]).toEqual(
		expect.objectContaining({
			get: expect.objectContaining({ operationId: "listPersonalConnections" }),
		}),
	)
})

test("live Doppler: CLI/API save, replace, isolate Owners, and drop with no values in output", async ({
	identity,
	organization,
	platform,
	runCli,
}) => {
	const {
		headers,
		user: { id: userId },
	} = identity
	const { origin, harness } = platform
	const { slug } = organization
	const vaultConfig = parseSharedSecretsEnv(platform.env)
	const name = `CTX_SECRET_E2E_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`
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
		expect(result.exitCode).toBe(0)
		for (const value of values) expect(result.all.includes(value)).toBe(false)
		expect(JSON.parse(result.all)).toEqual({ name, owner })
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
	const output = JSON.stringify(harness.getLogs())
	for (const value of values) {
		expect(output.includes(value)).toBe(false)
		expect(output.includes(JSON.stringify(value).slice(1, -1))).toBe(false)
	}
	expect(output.includes(vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN)).toBe(false)
	expect(output.includes(headers.authorization)).toBe(false)
})
