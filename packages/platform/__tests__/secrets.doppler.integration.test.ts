import { test } from "@tests/secrets"
import { expect } from "vitest"
import { z } from "zod"
import { parseSharedSecretsEnv } from "@/env"
import type { Owner } from "@/owner"
import { secretKey } from "@/secrets.server"

// Writes reach the configured shared vault, outside the test database.
// Cleanup stays inside the body so the platform is alive when test-owned keys are dropped.
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
		authorization: `Bearer ${vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN}`,
	}
	const providerUrl = (owner: Owner) => {
		const url = new URL("https://api.doppler.com/v3/configs/config/secret")
		url.search = new URLSearchParams({
			config: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG,
			name: secretKey(owner, name),
			project: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT,
		}).toString()
		return url
	}
	const personalUrl = providerUrl({ id: userId, type: "personal" })
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
	const personalApi = `${origin}/api/secrets/personal/${encodeURIComponent(userId)}/${name}`
	const organizationApi = `${origin}/api/secrets/org/${encodeURIComponent(orgId)}/${name}`
	await using cleanup = new AsyncDisposableStack()
	for (const [url, api] of [
		[personalUrl, personalApi],
		[orgUrl, organizationApi],
	] as const) {
		cleanup.defer(async () => {
			if ((await readRaw(url)) === null) return
			const response = await fetch(api, { headers, method: "DELETE" })
			expect(response.status).toBe(200)
			await assertRawValue(url, null)
		})
	}
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
		type: "personal",
	})
	await assertRawValue(personalUrl, values[0])
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
	expect(await replaced.json()).toEqual({ name, owner: { id: userId, type: "personal" } })
	await assertRawValue(personalUrl, values[2])
	await assertRawValue(orgUrl, values[1])
	assertCli(await runCli(["secrets", "--org", slug, "set", name, "--stdin"], values[3]), {
		id: orgId,
		type: "organization",
	})
	await assertRawValue(orgUrl, values[3])
	await assertRawValue(personalUrl, values[2])
	assertCli(await runCli(["secrets", "drop", name]), { id: userId, type: "personal" })
	await assertRawValue(personalUrl, null)
	await assertRawValue(orgUrl, values[3])
	const dropped = await fetch(organizationApi, { headers, method: "DELETE" })
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
	expect(output.includes(vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN)).toBe(false)
	expect(output.includes(headers.authorization)).toBe(false)
})
