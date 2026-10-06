import type { Resources } from "@usecontextlayer/shared/slate"
import type { z } from "zod"
import type { assignmentSchema } from "@/app-connections.schema"
import type { App } from "@/apps.schema"
import type { AppAccess } from "@/apps.server"
import type { PlatformDb } from "@/database"
import type {
	AppConnectionAssignmentOwnerId,
	AppConnectionAssignmentOwnerType,
} from "@/database/models/public/AppConnectionAssignment"
import { getCredentialOwner, type Owner } from "@/owner"
import { authorizeOwner } from "@/owner.server"

function assignmentOwner(owner: Owner) {
	return {
		owner_id: owner.id as AppConnectionAssignmentOwnerId,
		owner_type: owner.type as AppConnectionAssignmentOwnerType,
	}
}

export async function assignAppConnection(
	db: PlatformDb,
	access: AppAccess,
	issuer: string,
	assignment: z.infer<typeof assignmentSchema>,
	resources: Resources,
) {
	const requirement = resources.connections[assignment.slug]
	if (!requirement) return { allowed: false, reason: "not-found" } as const
	const owner = getCredentialOwner(requirement.mode, access.app, access.identity.user)
	if (
		requirement.mode === "owner" &&
		!(await authorizeOwner(access.identity, issuer, owner))
	)
		return { allowed: false, reason: "forbidden" } as const
	const saved = await db
		.insertInto("app_connection_assignment")
		.values({ app_id: access.app.id, ...assignmentOwner(owner), ...assignment })
		.onConflict((conflict) =>
			conflict
				.columns(["app_id", "owner_type", "owner_id", "slug"])
				.doUpdateSet({ connection_id: assignment.connection_id }),
		)
		.returning(["slug", "connection_id"])
		.executeTakeFirstOrThrow()
	return { allowed: true, assignment: saved } as const
}

export function getAppConnectionAssignments(
	db: PlatformDb,
	appId: App["id"],
	owners: Owner[],
) {
	return db
		.selectFrom("app_connection_assignment")
		.select(["slug", "connection_id", "owner_type", "owner_id"])
		.where("app_id", "=", appId)
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
