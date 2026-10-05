import { appMemberSchema } from "@/app-members.schema"
import type { AppAccess } from "@/apps.server"
import type { PlatformDb } from "@/database"

export async function joinApp(db: PlatformDb, { app, identity }: AppAccess) {
	const member = appMemberSchema.parse({ app_id: app.id, user_id: identity.user.id })
	await db
		.insertInto("app_member")
		.values(member)
		.onConflict((conflict) => conflict.columns(["app_id", "user_id"]).doNothing())
		.execute()
	return member
}
