import { OpenAPIHono } from "@hono/zod-openapi"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { expect, test } from "vitest"
import { z } from "zod"
import { createApi } from "@/api"
import { appSchema } from "@/apps.schema"
import type { IdentityEnv } from "@/auth.middleware"
import type { AuthIdentity } from "@/auth.server"
import { saveCustomerState } from "@/billing.server"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

test("owner subscriptions gate execution while manifests and configuration stay available", async () => {
	const config = z
		.object({
			CTX_TEST_ORGANIZATION_ID: z.string().min(1),
			CTX_TEST_USER_ID: z.string().min(1),
			POLAR_ACCESS_TOKEN: z.string().min(1),
			POLAR_ENVIRONMENT: z.literal("sandbox"),
		})
		.parse(process.env)
	const polar = createPolarCore({
		accessToken: config.POLAR_ACCESS_TOKEN,
		environment: config.POLAR_ENVIRONMENT,
	})
	const [personal, organization] = await Promise.all([
		getStateExternalCustomers(polar)(config.CTX_TEST_USER_ID),
		getStateExternalCustomers(polar)(config.CTX_TEST_ORGANIZATION_ID),
	])
	expect(personal.type).toBe("individual")
	expect(organization.type).toBe("team")
	expect(personal.active_subscriptions.length).toBeGreaterThan(0)
	expect(organization.active_subscriptions.length).toBeGreaterThan(0)
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_billing_test: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_billing_test)
	const env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_billing_test,
	})
	// Identity is our domain input; provider state and PostgreSQL are real dependencies.
	const identity: AuthIdentity = {
		credential: { token: "unused-by-public-apps", type: "access-token" },
		user: { id: config.CTX_TEST_USER_ID },
	}
	const api = (viewer: AuthIdentity | null) => {
		const app = new OpenAPIHono<IdentityEnv>()
		app.use("*", async (c, next) => {
			c.set("db", db)
			c.set("config", env)
			c.set("identity", viewer)
			await next()
		})
		app.route("/api", createApi())
		return app
	}
	const anonymous = api(null)
	const signedIn = api(identity)
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	try {
		const [personalApp, organizationApp] = (
			await db
				.insertInto("app")
				.values([
					{
						owner_organization_id: null,
						owner_user_id: config.CTX_TEST_USER_ID,
						public_hostname: "personal.example.com",
						visibility: "public",
					},
					{
						owner_organization_id: config.CTX_TEST_ORGANIZATION_ID,
						owner_user_id: null,
						public_hostname: "organization.example.com",
						visibility: "public",
					},
				])
				.returningAll()
				.execute()
		).map((row) => appSchema.parse(row))
		if (!personalApp || !organizationApp) throw new Error("Expected both test apps")
		const resolve = (hostname: string, pathname: string) =>
			`/api/apps/resolve?${new URLSearchParams({ hostname, pathname })}`
		for (const app of [personalApp, organizationApp]) {
			expect((await anonymous.request(resolve(app.public_hostname, "/"))).status).toBe(
				402,
			)
			expect(
				(await anonymous.request(resolve(app.public_hostname, "/slate.json"))).status,
			).toBe(200)
			expect(
				(
					await signedIn.request(
						`/api/apps/${app.id}/connections/list`,
						post({ manifest: { connections: {} } }),
					)
				).status,
			).toBe(200)
			expect(
				(
					await signedIn.request(
						`/api/apps/${app.id}/connections/assign`,
						post({ connection_id: "test-connection", slug: "mail" }),
					)
				).status,
			).toBe(200)
			expect(
				(
					await signedIn.request(
						`/api/apps/${app.id}/tools/call`,
						post({ arguments: {}, slug: "unassigned", tool: "EXAMPLE" }),
					)
				).status,
			).toBe(402)
		}
		await saveCustomerState(db, personal, null)
		expect(
			(await anonymous.request(resolve(personalApp.public_hostname, "/"))).status,
		).toBe(200)
		expect(
			(await signedIn.request(resolve(organizationApp.public_hostname, "/"))).status,
		).toBe(402)
		await saveCustomerState(db, organization, null)
		expect(
			(await anonymous.request(resolve(organizationApp.public_hostname, "/"))).status,
		).toBe(200)
		expect(
			(
				await signedIn.request(
					`/api/apps/${organizationApp.id}/tools/call`,
					post({ arguments: {}, slug: "unassigned", tool: "EXAMPLE" }),
				)
			).status,
		).toBe(404)
		await db
			.updateTable("app")
			.set({ visibility: "private" })
			.where("id", "=", personalApp.id)
			.execute()
		expect(
			(await anonymous.request(resolve(personalApp.public_hostname, "/slate.json")))
				.status,
		).toBe(401)
		expect(
			(await signedIn.request(resolve(personalApp.public_hostname, "/slate.json")))
				.status,
		).toBe(200)
		expect((await anonymous.request("/api/polar/webhooks", post({}))).status).toBe(403)
	} finally {
		await db.destroy()
		await databases.dropAll()
	}
})
