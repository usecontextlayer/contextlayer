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
	getStateExternalCustomers,
} from "@polar-sh/sdk/2026-10/services/customers"
import {
	createDiscounts,
	deleteDiscounts,
} from "@polar-sh/sdk/2026-10/services/discounts"
import { listProducts } from "@polar-sh/sdk/2026-10/services/products"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { appSchema } from "@/apps.schema"
import { checkAppBilling, saveCustomerState } from "@/billing.server"

test("owner subscriptions gate execution while declaration access stays available", async ({
	db,
	identity,
	organization,
	platform,
}) => {
	const { env, origin } = platform
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: env.POLAR_ENVIRONMENT,
	})
	const { headers, user } = identity
	const personalOwner = user.id
	const organizationOwner = organization.id
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
					`/api/connections/ca_example/tools/call`,
					post({ app_id: app.id, arguments: {}, tool: "EXAMPLE", toolkit: "gmail" }),
				)
			).status,
		).toBe(402)
	}
	for (const app of [personalApp, organizationApp]) await expectBlocked(app)
	for (const [app, owner] of [
		[personalApp, { id: personalOwner, type: "user" }],
		[organizationApp, { id: organizationOwner, type: "organization" }],
	] as const) {
		const state = await getStateExternalCustomers(polar)(owner.id)
		expect(state.active_subscriptions).toEqual([
			expect.objectContaining({ product_id: env.POLAR_FREE_PRODUCT_ID }),
		])
		await saveCustomerState(db, state, null)
		const response = await request(resolve(app.public_hostname, "/"))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ id: app.id, owner })
		if (app.id === personalApp.id) await expectBlocked(organizationApp)
	}
	const privateApp = await db
		.insertInto("app")
		.values({
			owner_user_id: personalOwner,
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

test("a non-Free subscription admits execution without a live balance lookup", async ({
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
	await saveCustomerState(db, await getStateCustomers(polar)(customer.id), null)
	const app = appSchema.parse(
		await db
			.insertInto("app")
			.values({
				owner_user_id: ownerId,
				public_hostname: "paid.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	expect(
		await checkAppBilling(
			db,
			{ ...env, POLAR_ACCESS_TOKEN: "deliberately-invalid" },
			app,
		),
	).toEqual({ allowed: true })
})
