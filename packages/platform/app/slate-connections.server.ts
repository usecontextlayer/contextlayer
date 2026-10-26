import type { z } from "zod"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { getCredentialOwner } from "@/owner"
import { authorizeOwner } from "@/owner.server"
import { assignmentOwner, type assignmentSchema } from "@/slate-connections.schema"
import type { SlateDeclarationSnapshot } from "@/slate-declarations.server"
import { addSlateMember } from "@/slate-members.server"
import type { OwnerSlateAccess } from "@/slates.server"

export async function assignSlateConnection(
	db: PlatformDb,
	memberProvisioning: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"],
	config: PlatformConfig,
	access: OwnerSlateAccess,
	assignment: z.infer<typeof assignmentSchema>,
	snapshot: SlateDeclarationSnapshot,
) {
	const requirement = snapshot.resources.connections[assignment.slug]
	if (!requirement) return { allowed: false, reason: "not-found" } as const
	const owner = getCredentialOwner(requirement.mode, access.slate, access.identity.user)
	if (
		requirement.mode === "owner" &&
		!(await authorizeOwner(access.identity, config.CTX_AUTH_ISSUER, owner))
	)
		return { allowed: false, reason: "forbidden" } as const
	const saved = await db
		.insertInto("slate_connection_assignment")
		.values({ slate_id: access.slate.id, ...assignmentOwner(owner), ...assignment })
		.onConflict((conflict) =>
			conflict
				.columns(["slate_id", "owner_type", "owner_id", "slug"])
				.doUpdateSet({ account_id: assignment.account_id }),
		)
		.returning(["slug", "account_id"])
		.executeTakeFirstOrThrow()
	await addSlateMember(
		db,
		memberProvisioning,
		config,
		access.slate,
		access.identity.user,
		snapshot,
	)
	return { allowed: true, assignment: saved } as const
}
