import { test as base } from "@tests/integration"
import { runCli, test } from "@tests/secrets"
import { expect } from "vitest"
import { z } from "zod"
import { accountsSchema } from "@/accounts.schema"

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
			(await fetch(`${origin}/api/secrets/personal/${userId}/${name}`, request)).status,
		).toBe(401)
		for (const type of ["personal", "org"]) {
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
		(await fetch(`${origin}/api/secrets/personal/${userId}/${name}`, { headers })).status,
	).toBe(404)
})

base(
	"non-writing: CLI requires explicit stdin input and resolves organization membership",
	async ({ commandEnv }) => {
		const nonTerminal = await runCli(commandEnv, [
			"secrets",
			"set",
			"CTX_SECRET_ACCESS_TEST",
		])
		expect(nonTerminal.exitCode).toBe(1)
		expect(nonTerminal.all).toContain("Use --stdin")
		const unknownOrg = await runCli(commandEnv, [
			"secrets",
			"--org",
			"not-a-member",
			"drop",
			"CTX_SECRET_ACCESS_TEST",
		])
		expect(unknownOrg.exitCode).toBe(1)
		expect(unknownOrg.all).toContain("Organization is not in your memberships")
	},
)

test("non-writing: Owner accounts enforce access and list through the real API and CLI", async ({
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
	const personalUrl = `${origin}/api/accounts/personal/${encodeURIComponent(userId)}`
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
		for (const type of ["personal", "org"]) {
			expect(
				(
					await fetch(`${origin}/api/accounts/${type}/not-this-owner`, {
						...request,
						headers: { ...request.headers, ...headers },
					})
				).status,
			).toBe(403)
		}
	}
	for (const [url, args] of [
		[personalUrl, ["accounts", "list"]],
		[
			`${origin}/api/accounts/org/${encodeURIComponent(organization.id)}`,
			["accounts", "--org", slug, "list"],
		],
	] as const) {
		const response = await fetch(url, { headers })
		expect(response.status).toBe(200)
		const { accounts } = accountsSchema.parse(await response.json())
		const cli = await runCli([...args])
		expect(cli.exitCode).toBe(0)
		if (accounts.length === 0) expect(cli.all).toContain("No connected accounts.")
		for (const account of accounts) expect(cli.all).toContain(account.id)
	}
	const unknownOrg = await runCli(["accounts", "--org", "not-a-member", "list"])
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
	expect(paths["/accounts/{type}/{owner_id}"]).toEqual(
		expect.objectContaining({
			get: expect.objectContaining({ operationId: "listAccounts" }),
			post: expect.objectContaining({ operationId: "connectAccount" }),
		}),
	)
	expect(paths["/accounts"]).toEqual(
		expect.objectContaining({
			get: expect.objectContaining({ operationId: "listPersonalAccounts" }),
		}),
	)
})
