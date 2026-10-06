import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { expect, test } from "vitest"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import { startPlatformWorker } from "@/testing"

test("owner subscriptions gate execution while declaration access stays available", async () => {
	const config = z
		.object({
			CTX_TEST_ACCESS_TOKEN: z.string().min(1),
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
	const headers = { authorization: `Bearer ${config.CTX_TEST_ACCESS_TOKEN}` }
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	let worker: Awaited<ReturnType<typeof startPlatformWorker>> | undefined
	try {
		worker = await startPlatformWorker(env, process.env)
		const origin = await worker.ready
		const request = (path: string, init?: RequestInit) =>
			fetch(new URL(path, origin), init)
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
			expect((await request(resolve(app.public_hostname, "/"))).status).toBe(402)
			expect((await request(resolve(app.public_hostname, "/slate.json"))).status).toBe(
				200,
			)
			expect(
				(
					await request(
						`/api/apps/${app.id}/tools/call`,
						post({ arguments: {}, slug: "unassigned", tool: "EXAMPLE" }),
					)
				).status,
			).toBe(402)
		}
		await saveCustomerState(db, personal, null)
		expect((await request(resolve(personalApp.public_hostname, "/"))).status).toBe(200)
		expect(
			(await request(resolve(organizationApp.public_hostname, "/"), { headers })).status,
		).toBe(402)
		await saveCustomerState(db, organization, null)
		expect((await request(resolve(organizationApp.public_hostname, "/"))).status).toBe(
			200,
		)
		await db
			.updateTable("app")
			.set({ visibility: "private" })
			.where("id", "=", personalApp.id)
			.execute()
		expect(
			(await request(resolve(personalApp.public_hostname, "/slate.json"))).status,
		).toBe(401)
		expect(
			(await request(resolve(personalApp.public_hostname, "/slate.json"), { headers }))
				.status,
		).toBe(200)
		expect((await request("/api/polar/webhooks", post({}))).status).toBe(403)
	} finally {
		worker?.server.kill("SIGTERM")
		if (worker) await worker.exited
		await db.destroy()
		await databases.dropAll()
	}
})
