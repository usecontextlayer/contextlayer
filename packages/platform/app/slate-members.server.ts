import { provisionAgentSchedules } from "@/agent-schedules.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import type { PlatformConfig } from "@/env"
import { migrateSlateDatabases } from "@/slate-database-migrations.server"
import type { SlateDeclarationSnapshot } from "@/slate-declarations.server"
import { slateMemberSchema } from "@/slate-members.schema"
import { prepareSlateProvisioning } from "@/slate-provisioning.server"
import {
	getSlateResourceConfiguration,
	resolveSlateResourceConfiguration,
} from "@/slate-resource-configuration.server"
import type { Slate } from "@/slates.schema"

export async function isSlateMember(
	db: PlatformDb,
	slateId: SlateId,
	user: { id: string },
) {
	const member = await db
		.selectFrom("slate_member")
		.select("user_id")
		.where("slate_id", "=", slateId)
		.where("user_id", "=", slateMemberSchema.shape.user_id.parse(user.id))
		.executeTakeFirst()
	return member !== undefined
}

export async function addSlateMember(
	db: PlatformDb,
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	slate: Slate,
	user: { id: string },
	snapshot: SlateDeclarationSnapshot,
) {
	if (slate.visibility === "public")
		return { allowed: false, reason: "forbidden" } as const
	if (await isSlateMember(db, slate.id, user)) return { allowed: true } as const
	const configuration = await getSlateResourceConfiguration(
		db,
		config,
		slate,
		user,
		snapshot.resources,
	)
	const resolved = resolveSlateResourceConfiguration(configuration)
	if (!resolved.allowed) return resolved
	const member = slateMemberSchema.parse({
		slate_id: slate.id,
		user_id: user.id,
	})
	await db.transaction().execute(async (trx) => {
		const inserted = await trx
			.insertInto("slate_member")
			.values(member)
			.onConflict((conflict) => conflict.columns(["slate_id", "user_id"]).doNothing())
			.returning("user_id")
			.executeTakeFirst()
		if (inserted) {
			const prepared = prepareSlateProvisioning(
				slate,
				[{ id: user.id, type: "user" }],
				snapshot,
			)
			await migrateSlateDatabases(artifacts, sandbox, prepared)
			await provisionAgentSchedules(artifacts, agents, prepared)
		}
	})
	return { allowed: true } as const
}

export async function listSlateMembers(db: PlatformDb, slateId: SlateId) {
	return db
		.selectFrom("slate_member")
		.selectAll()
		.where("slate_id", "=", slateId)
		.execute()
}
