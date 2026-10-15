import type { z } from "zod"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type {
	SlateConnectionAssignmentOwnerId,
	SlateConnectionAssignmentOwnerType,
} from "@/database/models/public/SlateConnectionAssignment"
import { getCredentialOwner, type Owner } from "@/owner"
import { authorizeOwner } from "@/owner.server"
import type { assignmentSchema } from "@/slate-connections.schema"
import type { SlateDeclarationSnapshot } from "@/slate-declarations.server"
import { prepareSlateResourceExecution } from "@/slate-resources.server"
import type { Slate } from "@/slates.schema"
import type { OwnerSlateAccess } from "@/slates.server"

function assignmentOwner(owner: Owner) {
	return {
		owner_id: owner.id as SlateConnectionAssignmentOwnerId,
		owner_type: owner.type as SlateConnectionAssignmentOwnerType,
	}
}

export async function assignSlateConnection(
	db: PlatformDb,
	bindings: PlatformEnv["Bindings"],
	access: OwnerSlateAccess,
	issuer: string,
	assignment: z.infer<typeof assignmentSchema>,
	snapshot: SlateDeclarationSnapshot,
) {
	const requirement = snapshot.resources.connections[assignment.slug]
	if (!requirement) return { allowed: false, reason: "not-found" } as const
	const owner = getCredentialOwner(requirement.mode, access.slate, access.identity.user)
	if (
		requirement.mode === "owner" &&
		!(await authorizeOwner(access.identity, issuer, owner))
	)
		return { allowed: false, reason: "forbidden" } as const
	const saved = await db
		.insertInto("slate_connection_assignment")
		.values({ slate_id: access.slate.id, ...assignmentOwner(owner), ...assignment })
		.onConflict((conflict) =>
			conflict
				.columns(["slate_id", "owner_type", "owner_id", "slug"])
				.doUpdateSet({ connection_id: assignment.connection_id }),
		)
		.returning(["slug", "connection_id"])
		.executeTakeFirstOrThrow()
	await prepareSlateResourceExecution(
		db,
		bindings,
		access.slate,
		{ id: access.identity.user.id, type: "user" },
		snapshot,
		snapshot.resources,
	)
	return { allowed: true, assignment: saved } as const
}

export function getSlateConnectionAssignments(
	db: PlatformDb,
	slateId: Slate["id"],
	owners: Owner[],
) {
	return db
		.selectFrom("slate_connection_assignment")
		.select(["slug", "connection_id", "owner_type", "owner_id"])
		.where("slate_id", "=", slateId)
		.where((eb) =>
			eb.or(
				owners.map((owner) => {
					const stored = assignmentOwner(owner)
					return eb.and([
						eb("owner_type", "=", stored.owner_type),
						eb("owner_id", "=", stored.owner_id),
					])
				}),
			),
		)
		.execute()
}
