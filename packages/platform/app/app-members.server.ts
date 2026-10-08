import { appMemberSchema } from "@/app-members.schema"
import { setupApp } from "@/app-setup.server"
import type { AppAccess } from "@/apps.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"

export type AppActor =
	| { type: "app" }
	| { type: "viewer"; id: string }
	| { type: "member"; id: string }

export async function getAppActor(
	db: PlatformDb,
	appId: AppId,
	user: { id: string } | null,
): Promise<AppActor> {
	if (!user) return { type: "app" }
	const member = await db
		.selectFrom("app_member")
		.select("user_id")
		.where("app_id", "=", appId)
		.where("user_id", "=", appMemberSchema.shape.user_id.parse(user.id))
		.executeTakeFirst()
	return { id: user.id, type: member ? "member" : "viewer" }
}

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
