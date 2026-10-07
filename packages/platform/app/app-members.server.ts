import { appMemberSchema } from "@/app-members.schema"
import { setupApp } from "@/app-setup.server"
import type { AppAccess } from "@/apps.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"

export async function joinApp(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	{ app, identity }: AppAccess,
) {
	const member = appMemberSchema.parse({ app_id: app.id, user_id: identity.user.id })
	await db
		.insertInto("app_member")
		.values(member)
		.onConflict((conflict) => conflict.columns(["app_id", "user_id"]).doNothing())
		.execute()
	await setupApp(artifacts, databases, agents, app, [
		{ id: identity.user.id, type: "user" },
	])
	return member
}

export async function listAppMembers(db: PlatformDb, appId: AppId) {
	return db.selectFrom("app_member").selectAll().where("app_id", "=", appId).execute()
}
