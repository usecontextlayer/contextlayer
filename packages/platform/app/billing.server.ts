import {
	createPolarCore,
	errors,
	type models,
	type PolarCore,
} from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { createSubscriptions } from "@polar-sh/sdk/2026-10/services/subscriptions"
import { sql } from "kysely"
import type { PlatformDb } from "@/database"
import type { PolarCustomerStateCustomerId } from "@/database/models/public/PolarCustomerState"
import type { PlatformConfig } from "@/env"
import { getSlateOwner } from "@/owner"
import type { Slate } from "@/slates.schema"

const CUSTOMER_STATE_MAX_AGE_MS = 60 * 60 * 1000

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

export async function saveCustomerState(db: PlatformDb, state: models.CustomerState) {
	return db
		.insertInto("polar_customer_state")
		.values({
			customer_id: state.id as PolarCustomerStateCustomerId,
			external_id: state.external_id ?? null,
			state,
		})
		.onConflict((conflict) =>
			conflict.column("customer_id").doUpdateSet((eb) => ({
				external_id: eb.ref("excluded.external_id"),
				refreshed_at: sql`now()`,
				state: eb.ref("excluded.state"),
			})),
		)
		.returning(["state", "refreshed_at"])
		.executeTakeFirstOrThrow()
}

export async function checkSlateBilling(
	db: PlatformDb,
	config: PlatformConfig,
	slate: Slate,
) {
	const owner = getSlateOwner(slate)
	let customer = await db
		.selectFrom("polar_customer_state")
		.select(["state", "refreshed_at"])
		.where("external_id", "=", owner.id)
		.executeTakeFirst()
	if (
		!customer ||
		Date.now() - customer.refreshed_at.getTime() > CUSTOMER_STATE_MAX_AGE_MS
	) {
		const polar = createPolarCore({
			accessToken: config.POLAR_ACCESS_TOKEN,
			environment: config.POLAR_ENVIRONMENT,
		})
		const state = await getStateExternalCustomers(polar)(owner.id).catch((error) => {
			if (error instanceof errors.ResourceNotFound) return undefined
			throw error
		})
		customer = state ? await saveCustomerState(db, state) : undefined
	}
	const billingUrl = new URL(
		owner.type === "organization" ? "/settings/organizations" : "/settings/billing",
		config.CTX_AUTH_ISSUER,
	).href
	const subscription = customer?.state.active_subscriptions[0]
	if (!customer || !subscription)
		return {
			allowed: false,
			message: `This slate's Owner needs an active plan. Manage billing at ${billingUrl}`,
			reason: "subscription-required",
		} as const

	const subscriptions = customer.state.active_subscriptions
	if (
		subscriptions.some(
			(subscription) => subscription.product_id !== config.POLAR_FREE_PRODUCT_ID,
		)
	)
		return { allowed: true } as const

	const meter = customer.state.active_meters.find(
		(active) => active.meter_id === config.POLAR_CLIPS_METER_ID,
	)
	if (meter && meter.balance > 0) return { allowed: true } as const

	const renewal = new Date(subscription.current_period_end).toLocaleDateString("en-US", {
		dateStyle: "long",
		timeZone: "UTC",
	})
	return {
		allowed: false,
		message: `This slate has no Free clips remaining. Free clips renew on ${renewal}. Free has no overage charges. The slate's Owner can upgrade at ${billingUrl}`,
		reason: "credits-exhausted",
	} as const
}
