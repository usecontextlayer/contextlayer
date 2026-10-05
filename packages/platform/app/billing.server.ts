import type { models } from "@polar-sh/sdk/2026-10"
import type { App } from "@/apps.schema"
import type { PlatformDb } from "@/database"
import type { PolarCustomerStateCustomerId } from "@/database/models/public/PolarCustomerState"
import { getAppOwner } from "@/owner"

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

export async function checkAppSubscription(db: PlatformDb, app: App) {
	const customer = await db
		.selectFrom("polar_customer_state")
		.select("state")
		.where("external_id", "=", getAppOwner(app).id)
		.executeTakeFirst()
	return (customer?.state.active_subscriptions.length ?? 0) > 0
}
