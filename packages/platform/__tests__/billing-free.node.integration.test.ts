import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import {
	createCustomers,
	deleteCustomers,
	getStateCustomers,
	listPaymentMethodsCustomers,
} from "@polar-sh/sdk/2026-10/services/customers"
import { ingestEvents } from "@polar-sh/sdk/2026-10/services/events"
import { getProducts } from "@polar-sh/sdk/2026-10/services/products"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { slateSchema } from "@/slates.schema"

test("signed Free enrollment grants credits and exhaustion denies runtime access after state refresh", async ({
	developmentDb: db,
	identity,
	serviceEnv,
}) => {
	const env = serviceEnv.platformEnv
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
	const origin = serviceEnv.addresses.CTX_PLATFORM_URL
	const freeProduct = await getProducts(polar)(env.POLAR_FREE_PRODUCT_ID)
	const clipsBenefit = freeProduct.benefits.find(
		(benefit) =>
			benefit.type === "meter_credit" &&
			benefit.properties.meter_id === env.POLAR_CLIPS_METER_ID,
	)
	assert(
		clipsBenefit?.type === "meter_credit",
		"The Free product must grant Clips credits",
	)
	const clips = clipsBenefit.properties.units
	for (const type of ["individual", "team"] as const) {
		await using scenario = new AsyncDisposableStack()
		const externalId = randomUUID()
		const customer = await createCustomers(polar)({
			email: `${externalId}@usecontextlayer.com`,
			external_id: externalId,
			name: `ContextLayer Free billing proof (${type})`,
			type,
		})
		scenario.defer(() => deleteCustomers(polar)(customer.id))
		const slate = slateSchema.parse(
			await db
				.insertInto("slate")
				.values({
					owner_organization_id: type === "team" ? externalId : null,
					owner_user_id: type === "individual" ? externalId : null,
					public_hostname: `${type}-${randomUUID().slice(0, 8)}.example.com`,
					visibility: "public",
				})
				.returningAll()
				.executeTakeFirstOrThrow(),
		)
		scenario.defer(async () => {
			await db.deleteFrom("slate").where("id", "=", slate.id).execute()
		})
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
			.toEqual({ balance: clips, product_id: env.POLAR_FREE_PRODUCT_ID })
		expect((await listPaymentMethodsCustomers(polar)(customer.id)).items).toEqual([])
		const resolve = (pathname: string) =>
			new URL(
				`/api/slates/resolve?${new URLSearchParams({ hostname: slate.public_hostname, pathname })}`,
				origin,
			)
		expect((await fetch(resolve("/"))).status).toBe(200)
		const usage = await ingestEvents(polar)({
			events: [
				{
					external_customer_id: externalId,
					metadata: { clips, user_code_worker_id: slate.id },
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
		await db
			.updateTable("polar_customer_state")
			.set({ refreshed_at: new Date(Date.now() - 2 * 60 * 60 * 1000) })
			.where("external_id", "=", externalId)
			.execute()
		const exhausted = await fetch(resolve("/"))
		expect(exhausted.status).toBe(402)
		const message = await exhausted.text()
		expect(message).toContain("Free clips renew on")
		expect(message).toContain("Free has no overage charges")
		expect(message).toContain(
			type === "team" ? "/settings/organizations" : "/settings/billing",
		)
		expect((await fetch(resolve("/slate.json"))).status).toBe(200)
		const response = await fetch(new URL("/api/accounts/unassigned/tools/call", origin), {
			body: JSON.stringify({
				arguments: {},
				slate_id: slate.id,
				tool: "EXAMPLE",
				toolkit: "gmail",
			}),
			headers: { ...identity.headers, "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status).toBe(402)
		expect(await response.text()).toBe(message)
	}
}, 300_000)
