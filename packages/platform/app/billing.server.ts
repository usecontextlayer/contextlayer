import { createPolarCore, type models, type PolarCore } from "@polar-sh/sdk/2026-10"
import { getStateCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { createSubscriptions } from "@polar-sh/sdk/2026-10/services/subscriptions"
import type { App } from "@/apps.schema"
import type { PlatformDb } from "@/database"
import type { PolarCustomerStateCustomerId } from "@/database/models/public/PolarCustomerState"
import type { PlatformConfig } from "@/env"
import { getAppOwner } from "@/owner"

export async function enrollFreeCustomer(
	polar: PolarCore,
	customerId: string,
	freeProductId: string,
) {
	return createSubscriptions(polar)({
		customer_id: customerId,
		product_id: freeProductId,
	})
}

export async function saveCustomerState(
	db: PlatformDb,
	state: models.CustomerState,
	eventTimestamp: string | null,
) {
	await db
		.insertInto("polar_customer_state")
		.values({
			customer_id: state.id as PolarCustomerStateCustomerId,
			event_timestamp: eventTimestamp,
			external_id: state.external_id ?? null,
			state,
		})
		.onConflict((conflict) =>
			conflict.column("customer_id").doUpdateSet((eb) => ({
				event_timestamp: eb.ref("excluded.event_timestamp"),
				external_id: eb.ref("excluded.external_id"),
				state: eb.ref("excluded.state"),
			})),
		)
		.execute()
}

export async function checkAppBilling(db: PlatformDb, config: PlatformConfig, app: App) {
	const owner = getAppOwner(app)
	const customer = await db
		.selectFrom("polar_customer_state")
		.select("state")
		.where("external_id", "=", owner.id)
		.executeTakeFirst()
	const billingUrl = new URL(
		owner.type === "organization" ? "/settings/organizations" : "/settings/billing",
		config.CTX_AUTH_ISSUER,
	).href
	const subscription = customer?.state.active_subscriptions[0]
	if (!customer || !subscription)
		return {
			allowed: false,
			message: `This app's owner needs an active plan. Manage billing at ${billingUrl}`,
			reason: "subscription-required",
		} as const

	const subscriptions = customer.state.active_subscriptions
	if (
		subscriptions.some(
			(subscription) => subscription.product_id !== config.POLAR_FREE_PRODUCT_ID,
		)
	)
		return { allowed: true } as const

	const polar = createPolarCore({
		accessToken: config.POLAR_ACCESS_TOKEN,
		environment: config.POLAR_ENVIRONMENT,
	})
	const state = await getStateCustomers(polar)(customer.state.id)
	const meter = state.active_meters.find(
		(active) => active.meter_id === config.POLAR_CLIPS_METER_ID,
	)
	if (meter && meter.balance > 0) return { allowed: true } as const

	const renewal = new Date(subscription.current_period_end).toLocaleDateString("en-US", {
		dateStyle: "long",
		timeZone: "UTC",
	})
	return {
		allowed: false,
		message: `This app has no Free clips remaining. Free clips renew on ${renewal}. Free has no overage charges. The app's owner can upgrade at ${billingUrl}`,
		reason: "credits-exhausted",
	} as const
}
