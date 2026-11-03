import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { execa } from "execa"
import postgres from "postgres"
import { expect, test } from "vitest"
import { provisionEphemeralDatabases, seedDatabase } from "@/database"
import { readDevEnv } from "@/env"
import seed from "@/seed.json" with { type: "json" }

const root = resolve(import.meta.dirname, "../../..")
const webRoot = resolve(root, "../web")

test("seeding bootstraps the development identity and CLI registration without duplicates", async () => {
	await using resources = new AsyncDisposableStack()
	const databases = await provisionEphemeralDatabases(readDevEnv().DATABASE_URL, {
		baseNames: ["ctx_seed_web"],
		async migrate({ ctx_seed_web: DATABASE_URL }) {
			await execa("pnpm", ["db.latest", "--ci"], {
				cwd: webRoot,
				env: { DATABASE_URL, NODE_ENV: "development" },
				stdio: "inherit",
			})
		},
	})
	resources.defer(databases.dropAll)
	const sql = postgres(databases.urls.ctx_seed_web, { max: 1 })
	resources.defer(() => sql.end())
	const template = await readFile(resolve(webRoot, "database/dev-seed.sql"), "utf8")
	for (let application = 0; application < 2; application++) {
		await seedDatabase(databases.urls.ctx_seed_web, template, seed)
		expect(await sql`SELECT id, name, email, "emailVerified" FROM "user"`).toEqual([
			seed.web.user,
		])
		expect(await sql`SELECT "accountId", "providerId", "userId" FROM account`).toEqual([
			{
				accountId: seed.web.user.id,
				providerId: "credential",
				userId: seed.web.user.id,
			},
		])
		expect(await sql`SELECT id, name, slug FROM organization`).toEqual([
			seed.web.organization,
		])
		expect(await sql`SELECT "organizationId", "userId", role FROM member`).toEqual([
			{
				organizationId: seed.web.organization.id,
				role: seed.web.membership.role,
				userId: seed.web.user.id,
			},
		])
		expect(
			await sql`SELECT "clientId", "userId", "clientSecret", disabled,
			"tokenEndpointAuthMethod", ("grantTypes" #>> '{}')::jsonb AS "grantTypes",
			(scopes #>> '{}')::jsonb AS scopes FROM "oauthClient"`,
		).toEqual([
			{
				clientId: seed.web.client.clientId,
				clientSecret: null,
				disabled: false,
				grantTypes: seed.web.client.grantTypes,
				scopes: seed.web.client.scopes,
				tokenEndpointAuthMethod: seed.web.client.tokenEndpointAuthMethod,
				userId: seed.web.user.id,
			},
		])
		expect(
			await sql`SELECT identifier, disabled,
			("allowedScopes" #>> '{}')::jsonb AS "allowedScopes" FROM "oauthResource"`,
		).toEqual([
			{
				allowedScopes: seed.web.resource.allowedScopes,
				disabled: false,
				identifier: seed.web.resource.identifier,
			},
		])
		expect(await sql`SELECT "clientId", "resourceId" FROM "oauthClientResource"`).toEqual(
			[
				{
					clientId: seed.web.client.clientId,
					resourceId: seed.web.resource.identifier,
				},
			],
		)
	}
})
