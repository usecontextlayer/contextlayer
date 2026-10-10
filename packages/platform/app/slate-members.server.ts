import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import { slateMemberSchema } from "@/slate-members.schema"
import { provisionSlate } from "@/slate-provisioning.server"
import type { OwnerSlateAccess } from "@/slates.server"

export type SlateActor =
	| { type: "app" }
	| { type: "viewer"; id: string }
	| { type: "member"; id: string }

export async function getSlateActor(
	db: PlatformDb,
	slateId: SlateId,
	user: { id: string } | null,
): Promise<SlateActor> {
	if (!user) return { type: "app" }
	const member = await db
		.selectFrom("slate_member")
		.select("user_id")
		.where("slate_id", "=", slateId)
		.where("user_id", "=", slateMemberSchema.shape.user_id.parse(user.id))
		.executeTakeFirst()
	return { id: user.id, type: member ? "member" : "viewer" }
}

export async function joinSlate(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	{ slate, identity }: OwnerSlateAccess,
) {
	const member = slateMemberSchema.parse({
		slate_id: slate.id,
		user_id: identity.user.id,
	})
	await db
		.insertInto("slate_member")
		.values(member)
		.onConflict((conflict) => conflict.columns(["slate_id", "user_id"]).doNothing())
		.execute()
	await provisionSlate(artifacts, databases, agents, slate, [
		{ id: identity.user.id, type: "user" },
	])
	return member
}

export async function listSlateMembers(db: PlatformDb, slateId: SlateId) {
	return db
		.selectFrom("slate_member")
		.selectAll()
		.where("slate_id", "=", slateId)
		.execute()
}
