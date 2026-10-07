import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { createPolarCore, type models } from "@polar-sh/sdk/2026-10"
import {
	createCustomers,
	getStateCustomers,
	listPaymentMethodsCustomers,
} from "@polar-sh/sdk/2026-10/services/customers"
import { ingestEvents } from "@polar-sh/sdk/2026-10/services/events"
import {
	createWebhookEndpointWebhooks,
	deleteWebhookEndpointWebhooks,
} from "@polar-sh/sdk/2026-10/services/webhooks"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const worker = createTestHarness()
let databases: ProvisionedDatabases<"ctx_free_billing_test">
let db: ReturnType<typeof createPlatformDb>
let env: ReturnType<typeof parsePlatformEnv>
let polar: ReturnType<typeof createPolarCore>
let endpoint: models.WebhookEndpoint | undefined
let tunnel: ChildProcessWithoutNullStreams | undefined
let directory: string | undefined
let origin: string
let authorization: string
let email: string

beforeAll(async () => {
	z.literal("sandbox").parse(process.env.POLAR_ENVIRONMENT)
	authorization = `Bearer ${z.string().min(1).parse(process.env.CTX_TEST_ACCESS_TOKEN)}`
	email = z.email().parse(process.env.CTX_TEST_USER_EMAIL)
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_free_billing_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_free_billing_test)
	env = parsePlatformEnv({
		...process.env,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_free_billing_test,
	})
	polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
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
	directory = await mkdtemp(join(tmpdir(), "ctx-free-billing-"))
	const policy = join(directory, "traffic-policy.json")
	await writeFile(
		policy,
		JSON.stringify({
			on_http_request: [
				{
					actions: [
						{ config: { body: "Not found", status_code: 404 }, type: "custom-response" },
					],
					expressions: ["req.url.path != '/api/polar/webhooks' || req.method != 'POST'"],
				},
			],
		}),
	)
	tunnel = spawn("ngrok", [
		"http",
		origin,
		"--inspect=false",
		"--log=stdout",
		"--log-format=json",
		`--traffic-policy-file=${policy}`,
	])
	tunnel.stderr.pipe(process.stderr)
	const lines = createInterface({ input: tunnel.stdout })
	let publicUrl: string | undefined
	for await (const line of lines) {
		const log = z.object({ url: z.url().optional() }).parse(JSON.parse(line))
		if (log.url) {
			publicUrl = log.url
			break
		}
	}
	if (!publicUrl) throw new Error("ngrok did not create the test webhook tunnel")
	endpoint = await createWebhookEndpointWebhooks(polar)({
		api_version: "2026-10",
		events: ["customer.created", "customer.state_changed"],
		format: "raw",
		name: `ctx Free billing proof ${randomUUID()}`,
		url: new URL("/api/polar/webhooks", publicUrl).href,
	})
	const signingSecret = endpoint.secret
	await worker.update((current) => ({
		...current,
		workers: current.workers.map((input) => ({
			...input,
			secrets: { ...env, POLAR_WEBHOOK_SECRET: signingSecret },
		})),
	}))
})

afterAll(async () => {
	if (endpoint) await deleteWebhookEndpointWebhooks(polar)(endpoint.id)
	tunnel?.kill("SIGTERM")
	await worker.close()
	await db?.destroy()
	await databases?.dropAll()
	if (directory) await rm(directory, { recursive: true })
})

test("signed Free enrollment grants credits and exhaustion denies runtime access", async () => {
	for (const type of ["individual", "team"] as const) {
		const externalId = `ctx-free-billing-${type}-${randomUUID()}`
		const customer = await createCustomers(polar)({
			email: email.replace("@", `+ctx-free-${randomUUID().slice(0, 8)}@`),
			external_id: externalId,
			name: `ContextLayer Free billing proof (${type})`,
			type,
		})
		console.log(
			JSON.stringify({
				customer_id: customer.id,
				external_id: externalId,
				fixture: type,
			}),
		)
		const app = appSchema.parse(
			await db
				.insertInto("app")
				.values({
					owner_organization_id: type === "team" ? externalId : null,
					owner_user_id: type === "individual" ? externalId : null,
					public_hostname: `${type}-${randomUUID().slice(0, 8)}.example.com`,
					visibility: "public",
				})
				.returningAll()
				.executeTakeFirstOrThrow(),
		)
		await expect
			.poll(
				async () => {
					const saved = await db
						.selectFrom("polar_customer_state")
						.select("state")
						.where("external_id", "=", externalId)
						.executeTakeFirst()
					return {
						balance: saved?.state.active_meters.find(
							(meter) => meter.meter_id === env.POLAR_CLIPS_METER_ID,
						)?.balance,
						product_id: saved?.state.active_subscriptions[0]?.product_id,
					}
				},
				{ interval: 1000, timeout: 60_000 },
			)
			.toEqual({ balance: 5000, product_id: env.POLAR_FREE_PRODUCT_ID })
		expect((await listPaymentMethodsCustomers(polar)(customer.id)).items).toEqual([])
		const resolve = (pathname: string) =>
			new URL(
				`/api/apps/resolve?${new URLSearchParams({ hostname: app.public_hostname, pathname })}`,
				origin,
			)
		expect((await fetch(resolve("/"))).status).toBe(200)
		const usage = await ingestEvents(polar)({
			events: [
				{
					external_customer_id: externalId,
					metadata: { clips: 5000, user_code_worker_id: app.id },
					name: "tool_call",
				},
			],
		})
		expect(usage.inserted).toBe(1)
		await expect
			.poll(
				async () =>
					(await getStateCustomers(polar)(customer.id)).active_meters.find(
						(meter) => meter.meter_id === env.POLAR_CLIPS_METER_ID,
					)?.balance,
				{ interval: 1000, timeout: 60_000 },
			)
			.toBe(0)
		const exhausted = await fetch(resolve("/"))
		expect(exhausted.status).toBe(402)
		const message = await exhausted.text()
		expect(message).toContain("Free clips renew on")
		expect(message).toContain("Free has no overage charges")
		expect(message).toContain(
			type === "team" ? "/settings/organizations" : "/settings/billing",
		)
		expect((await fetch(resolve("/slate.json"))).status).toBe(200)
		for (const [path, body] of [
			[
				`/api/apps/${app.id}/tools/call`,
				{ arguments: {}, slug: "unassigned", tool: "EXAMPLE" },
			],
			[
				"/api/connections/unassigned/tools/call",
				{ app_id: app.id, arguments: {}, tool: "EXAMPLE", toolkit: "gmail" },
			],
		] as const) {
			const response = await fetch(new URL(path, origin), {
				body: JSON.stringify(body),
				headers: { authorization, "content-type": "application/json" },
				method: "POST",
			})
			expect(response.status).toBe(402)
			expect(await response.text()).toBe(message)
		}
		console.log(
			JSON.stringify({
				app_id: app.id,
				balance: 0,
				customer_id: customer.id,
				exhausted_status: 402,
				external_id: externalId,
				fixture: type,
				funded_status: 200,
			}),
		)
	}
}, 300_000)
