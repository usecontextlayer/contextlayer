import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import {
	clientConfirmCheckouts,
	createCheckouts,
} from "@polar-sh/sdk/2026-10/services/checkouts"
import {
	createCustomers,
	deleteCustomers,
	getStateCustomers,
} from "@polar-sh/sdk/2026-10/services/customers"
import {
	createDiscounts,
	deleteDiscounts,
} from "@polar-sh/sdk/2026-10/services/discounts"
import { ingestEvents } from "@polar-sh/sdk/2026-10/services/events"
import { getProducts, listProducts } from "@polar-sh/sdk/2026-10/services/products"
import { createSubscriptions } from "@polar-sh/sdk/2026-10/services/subscriptions"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { checkSlateBilling, saveCustomerState } from "@/billing.server"
import { slateSchema } from "@/slates.schema"

test("Owner subscriptions gate execution while declaration access stays available", async ({
	db,
	identity,
	organization,
	platform,
}) => {
	const { origin } = platform
	const { user } = identity
	const personalOwner = user.id
	const organizationOwner = organization.id
	const request = (path: string, init?: RequestInit) => fetch(new URL(path, origin), init)
	const [personalSlate, organizationSlate] = (
		await db
			.insertInto("slate")
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
	).map((row) => slateSchema.parse(row))
	if (!personalSlate || !organizationSlate) throw new Error("Expected both test slates")
	const resolve = (hostname: string, pathname: string) =>
		`/api/slates/resolve?${new URLSearchParams({ hostname, pathname })}`
	const expectBlocked = async (slate: typeof personalSlate) => {
		expect((await request(resolve(slate.public_hostname, "/"))).status).toBe(402)
		expect((await request(resolve(slate.public_hostname, "/slate.json"))).status).toBe(
			200,
		)
	}
	const slateWithoutPolarCustomer = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_user_id: randomUUID(),
				public_hostname: "missing-customer.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	await expectBlocked(slateWithoutPolarCustomer)
	for (const [slate, owner] of [
		[personalSlate, { id: personalOwner, type: "personal" }],
		[organizationSlate, { id: organizationOwner, type: "organization" }],
	] as const) {
		const response = await request(resolve(slate.public_hostname, "/"))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ id: slate.id, owner })
	}
})

test("missing state is pulled for an active non-Free customer and reused while fresh", async ({
	db,
	platformEnv: env,
}) => {
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
	const products = await listProducts(polar)({ is_archived: false, is_recurring: true })
	const product = products.items.find((product) =>
		product.prices.some(
			(price) => price.amount_type === "fixed" && price.price_amount > 0,
		),
	)
	assert(product, "The Sandbox catalog needs a paid recurring product")

	await using scenario = new AsyncDisposableStack()
	const discount = await createDiscounts(polar)({
		basis_points: 10_000,
		duration: "forever",
		max_redemptions: 1,
		name: "Billing admission integration",
		products: [product.id],
		type: "percentage",
	})
	scenario.defer(() => deleteDiscounts(polar)(discount.id))
	const ownerId = randomUUID()
	const slate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_user_id: ownerId,
				public_hostname: "paid.example.com",
				visibility: "private",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	expect(await checkSlateBilling(db, env, slate)).toMatchObject({
		allowed: false,
		reason: "subscription-required",
	})
	const customer = await createCustomers(polar)({
		email: `${ownerId}@usecontextlayer.com`,
		external_id: ownerId,
		name: "Billing admission integration",
	})
	scenario.defer(() => deleteCustomers(polar)(customer.id))
	const checkout = await createCheckouts(polar)({
		allow_trial: false,
		customer_id: customer.id,
		discount_id: discount.id,
		products: [product.id],
	})
	await clientConfirmCheckouts(polar)(checkout.client_secret, {
		customer_billing_address: { country: "GB" },
	})
	await expect
		.poll(() => getStateCustomers(polar)(customer.id), { timeout: 30_000 })
		.toMatchObject({
			active_subscriptions: expect.arrayContaining([
				expect.objectContaining({ product_id: product.id }),
			]),
		})
	expect(await checkSlateBilling(db, env, slate)).toEqual({ allowed: true })
	expect(
		await checkSlateBilling(
			db,
			{ ...env, POLAR_ACCESS_TOKEN: "deliberately-invalid" },
			slate,
		),
	).toEqual({ allowed: true })
})

test("an existing customer without a subscription is refused execution", async ({
	db,
	platformEnv: env,
}) => {
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
	await using scenario = new AsyncDisposableStack()
	const ownerId = randomUUID()
	const customer = await createCustomers(polar)({
		email: `${ownerId}@usecontextlayer.com`,
		external_id: ownerId,
		name: "Unsubscribed billing integration",
	})
	scenario.defer(() => deleteCustomers(polar)(customer.id))
	expect((await getStateCustomers(polar)(customer.id)).active_subscriptions).toEqual([])
	const slate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_user_id: ownerId,
				public_hostname: "unsubscribed.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	expect(await checkSlateBilling(db, env, slate)).toMatchObject({
		allowed: false,
		reason: "subscription-required",
	})
})

test("Free uses the saved balance until stale state is refreshed", async ({
	db,
	platformEnv: env,
}) => {
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
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
	await using scenario = new AsyncDisposableStack()
	const ownerId = randomUUID()
	const customer = await createCustomers(polar)({
		email: `${ownerId}@usecontextlayer.com`,
		external_id: ownerId,
		name: "Free saved balance integration",
	})
	scenario.defer(() => deleteCustomers(polar)(customer.id))
	await createSubscriptions(polar)({
		customer_id: customer.id,
		product_id: env.POLAR_FREE_PRODUCT_ID,
	})
	await expect
		.poll(() => getStateCustomers(polar)(customer.id), {
			interval: 1000,
			timeout: 60_000,
		})
		.toMatchObject({
			active_meters: expect.arrayContaining([
				expect.objectContaining({ balance: clips, meter_id: env.POLAR_CLIPS_METER_ID }),
			]),
			active_subscriptions: [
				expect.objectContaining({ product_id: env.POLAR_FREE_PRODUCT_ID }),
			],
		})
	await saveCustomerState(db, await getStateCustomers(polar)(customer.id))
	const slate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_user_id: ownerId,
				public_hostname: "free.example.com",
				visibility: "private",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	const invalidPolarTokenConfig = { ...env, POLAR_ACCESS_TOKEN: "deliberately-invalid" }
	expect(await checkSlateBilling(db, invalidPolarTokenConfig, slate)).toEqual({
		allowed: true,
	})
	const usage = await ingestEvents(polar)({
		events: [
			{
				external_customer_id: ownerId,
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
	expect(await checkSlateBilling(db, invalidPolarTokenConfig, slate)).toEqual({
		allowed: true,
	})
	const refreshedAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
	await db
		.updateTable("polar_customer_state")
		.set({ refreshed_at: refreshedAt })
		.where("external_id", "=", ownerId)
		.execute()
	const exhausted = await checkSlateBilling(db, env, slate)
	expect(exhausted).toMatchObject({
		allowed: false,
		message: expect.stringContaining("Free clips renew on"),
		reason: "credits-exhausted",
	})
	expect(await checkSlateBilling(db, invalidPolarTokenConfig, slate)).toEqual(exhausted)
}, 180_000)
