import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { saveCustomerState } from "@/billing.server"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const configSchema = z.object({
	CTX_TEST_ACCESS_TOKEN: z.string().min(1),
	CTX_TEST_ORGANIZATION_ID: z.string().min(1),
	CTX_TEST_POLAR_ORGANIZATION_SUBSCRIPTION_ID: z.uuid(),
	CTX_TEST_POLAR_USER_SUBSCRIPTION_ID: z.uuid(),
	CTX_TEST_USER_ID: z.string().min(1),
	POLAR_ACCESS_TOKEN: z.string().min(1),
	POLAR_ENVIRONMENT: z.literal("sandbox"),
})

const worker = createTestHarness()
let config: z.infer<typeof configSchema>
let polar: ReturnType<typeof createPolarCore>
let databases: ProvisionedDatabases<"ctx_billing_test">
let db: ReturnType<typeof createPlatformDb>
let headers: { authorization: string }
let origin: string

beforeAll(async () => {
	config = configSchema.parse(process.env)
	polar = createPolarCore({
		accessToken: config.POLAR_ACCESS_TOKEN,
		environment: config.POLAR_ENVIRONMENT,
	})
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_billing_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_billing_test)
	const env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_billing_test,
	})
	headers = { authorization: `Bearer ${config.CTX_TEST_ACCESS_TOKEN}` }
	await worker.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: env,
			},
		],
	})
	origin = (await worker.listen()).url.origin
})

afterAll(async () => {
	await worker.close()
	await db?.destroy()
	await databases?.dropAll()
})

test("owner subscriptions gate execution while declaration access stays available", async () => {
	const personalOwner = config.CTX_TEST_USER_ID
	const organizationOwner = config.CTX_TEST_ORGANIZATION_ID
	const post = (body: unknown) => ({
		body: JSON.stringify(body),
		headers: { ...headers, "content-type": "application/json" },
		method: "POST",
	})
	const request = (path: string, init?: RequestInit) => fetch(new URL(path, origin), init)
	const [personalApp, organizationApp] = (
		await db
			.insertInto("app")
			.values([
				{
					owner_organization_id: null,
					owner_user_id: personalOwner,
					public_hostname: "personal.example.com",
					visibility: "public",
				},
				{
					owner_organization_id: organizationOwner,
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
	const expectBlocked = async (app: typeof personalApp) => {
		expect((await request(resolve(app.public_hostname, "/"))).status).toBe(402)
		expect((await request(resolve(app.public_hostname, "/slate.json"))).status).toBe(200)
		expect(
			(
				await request(
					`/api/apps/${app.id}/tools/call`,
					post({ arguments: {}, slug: "unassigned", tool: "EXAMPLE" }),
				)
			).status,
		).toBe(402)
	}
	for (const app of [personalApp, organizationApp]) await expectBlocked(app)
	for (const [subscriptionId, app, owner] of [
		[
			config.CTX_TEST_POLAR_USER_SUBSCRIPTION_ID,
			personalApp,
			{ id: personalOwner, type: "user" },
		],
		[
			config.CTX_TEST_POLAR_ORGANIZATION_SUBSCRIPTION_ID,
			organizationApp,
			{ id: organizationOwner, type: "organization" },
		],
	] as const) {
		const state = await getStateExternalCustomers(polar)(owner.id)
		expect(state.active_subscriptions.map((active) => active.id)).toContain(
			subscriptionId,
		)
		await saveCustomerState(db, state, null)
		const response = await request(resolve(app.public_hostname, "/"))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ id: app.id, owner })
		if (app.id === personalApp.id) await expectBlocked(organizationApp)
	}
	const privateApp = await db
		.insertInto("app")
		.values({
			owner_user_id: config.CTX_TEST_USER_ID,
			public_hostname: "private.example.com",
			visibility: "private",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	expect((await request(resolve(privateApp.public_hostname, "/slate.json"))).status).toBe(
		401,
	)
	expect(
		(await request(resolve(privateApp.public_hostname, "/slate.json"), { headers }))
			.status,
	).toBe(200)
})
