import type { AppAccess } from "@/apps.server"
import type { PlatformDb } from "@/database"
import type { AppUserUserId } from "@/database/models/public/AppUser"

// Joining is a person's deliberate opt-in to an app: its agents may then act for them, with their
// individual connections and folders, while they are away. Everything individual hangs off it.
export async function joinApp(db: PlatformDb, { app, identity }: AppAccess) {
	await db
		.insertInto("app_user")
		.values({ app_id: app.id, user_id: identity.user.id as AppUserUserId })
		.onConflict((conflict) => conflict.columns(["app_id", "user_id"]).doNothing())
		.execute()
	return { app_id: app.id, user_id: identity.user.id }
}
