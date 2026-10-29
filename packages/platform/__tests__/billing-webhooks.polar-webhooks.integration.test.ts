import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import {
	createCustomers,
	deleteCustomers,
} from "@polar-sh/sdk/2026-10/services/customers"
import { getProducts } from "@polar-sh/sdk/2026-10/services/products"
import { revokeSubscriptions } from "@polar-sh/sdk/2026-10/services/subscriptions"
import { test } from "@tests/integration"
import { expect } from "vitest"

// Run with one DevEnv using --polar-listen. Billing reads would fill the cache even if webhook delivery failed.
test("signed customer-created and state-change events enroll Free and update personal and organization billing", async ({
	devEnvDb: db,
	serviceEnv,
}) => {
	const env = serviceEnv.platformEnv
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
	const product = await getProducts(polar)(env.POLAR_FREE_PRODUCT_ID)
	const benefit = product.benefits.find(
		(item) =>
			item.type === "meter_credit" &&
			item.properties.meter_id === env.POLAR_CLIPS_METER_ID,
	)
	assert(benefit?.type === "meter_credit", "Free must grant Clips credits")
	for (const type of ["individual", "team"] as const) {
		await using scenario = new AsyncDisposableStack()
		const externalId = randomUUID()
		const customer = await createCustomers(polar)({
			email: `${externalId}@usecontextlayer.com`,
			external_id: externalId,
			name: `Signed Free enrollment (${type})`,
			type,
		})
		scenario.defer(async () => {
			await deleteCustomers(polar)(customer.id)
			await db
				.deleteFrom("polar_customer_state")
				.where("external_id", "=", externalId)
				.execute()
		})
		const savedState = () =>
			db
				.selectFrom("polar_customer_state")
				.select("state")
				.where("external_id", "=", externalId)
				.executeTakeFirst()
		await expect
			.poll(async () => (await savedState())?.state, { interval: 1_000, timeout: 60_000 })
			.toMatchObject({
				active_meters: expect.arrayContaining([
					expect.objectContaining({
						balance: benefit.properties.units,
						meter_id: env.POLAR_CLIPS_METER_ID,
					}),
				]),
				active_subscriptions: [
					expect.objectContaining({ product_id: env.POLAR_FREE_PRODUCT_ID }),
				],
			})
		const subscription = (await savedState())?.state.active_subscriptions[0]
		assert(subscription)
		await revokeSubscriptions(polar)(subscription.id)
		await expect
			.poll(async () => (await savedState())?.state.active_subscriptions, {
				interval: 1_000,
				timeout: 60_000,
			})
			.toEqual([])
	}
}, 300_000)
