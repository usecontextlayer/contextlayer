import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import type { z } from "zod"
import type { assignmentSchema } from "@/app-connections.schema"
import type { ResourcesSnapshot } from "@/app-resources.server"
import type { App } from "@/apps.schema"
import { type AppAccess, authorizeAppManagement } from "@/apps.server"
import { listOrganizations } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type {
	AppConnectionAssignmentOwnerId,
	AppConnectionAssignmentOwnerType,
	AppConnectionAssignmentSlug,
} from "@/database/models/public/AppConnectionAssignment"
import { getAppOwner, getCredentialOwner, type Owner } from "@/owner"

function assignmentOwner(owner: Owner) {
	return {
		owner_id: owner.id as AppConnectionAssignmentOwnerId,
		owner_type: owner.type as AppConnectionAssignmentOwnerType,
	}
}

async function resolveConnectionRequirement(
	access: AppAccess,
	issuer: string,
	slug: string,
	operation: "configure" | "execute",
	{ resources, source }: ResourcesSnapshot,
) {
	const requirements =
		operation === "execute" ? resourcesForConsumer(resources, { type: "app" }) : resources
	const requirement = requirements.connections[slug]
	if (!requirement) return { allowed: false, reason: "not-found" } as const
	// Only app managers may substitute authored requirements or configure owner accounts.
	if (source === "local" || (operation === "configure" && requirement.mode === "owner")) {
		const organizations = access.app.owner_organization_id
			? await listOrganizations(access.identity, issuer)
			: []
		if (
			!authorizeAppManagement(
				access.app,
				access.identity,
				organizations.some(
					(organization) => organization.id === access.app.owner_organization_id,
				),
			).allowed
		)
			return { allowed: false, reason: "forbidden" } as const
	}
	return {
		allowed: true,
		owner: getCredentialOwner(requirement.mode, access.app, access.identity.user),
		requirement,
	} as const
}

export async function assignAppConnection(
	db: PlatformDb,
	access: AppAccess,
	issuer: string,
	assignment: z.infer<typeof assignmentSchema>,
	snapshot: ResourcesSnapshot,
) {
	const resolved = await resolveConnectionRequirement(
		access,
		issuer,
		assignment.slug,
		"configure",
		snapshot,
	)
	if (!resolved.allowed) return resolved
	const saved = await db
		.insertInto("app_connection_assignment")
		.values({ app_id: access.app.id, ...assignmentOwner(resolved.owner), ...assignment })
		.onConflict((conflict) =>
			conflict
				.columns(["app_id", "owner_type", "owner_id", "slug"])
				.doUpdateSet({ connection_id: assignment.connection_id }),
		)
		.returning(["slug", "connection_id"])
		.executeTakeFirstOrThrow()
	return { allowed: true, assignment: saved } as const
}

export async function resolveAppConnection(
	db: PlatformDb,
	access: AppAccess,
	issuer: string,
	slug: AppConnectionAssignmentSlug,
	snapshot: ResourcesSnapshot,
) {
	const resolved = await resolveConnectionRequirement(
		access,
		issuer,
		slug,
		"execute",
		snapshot,
	)
	if (!resolved.allowed) return resolved
	const assignment = await getAppConnectionAssignment(
		db,
		access.app.id,
		resolved.owner,
		slug,
	)
	if (!assignment) return { allowed: false, reason: "not-found" } as const
	return {
		allowed: true,
		...assignment,
		owner: resolved.owner,
		requirement: resolved.requirement,
	} as const
}

export function getAppConnectionAssignment(
	db: PlatformDb,
	appId: App["id"],
	credentialOwner: Owner,
	slug: AppConnectionAssignmentSlug,
) {
	const owner = assignmentOwner(credentialOwner)
	return db
		.selectFrom("app_connection_assignment")
		.select("connection_id")
		.where("app_id", "=", appId)
		.where("owner_type", "=", owner.owner_type)
		.where("owner_id", "=", owner.owner_id)
		.where("slug", "=", slug)
		.executeTakeFirst()
}

export async function listAppConnections(
	db: PlatformDb,
	access: AppAccess,
	{ resources }: ResourcesSnapshot,
) {
	const owners = [
		getAppOwner(access.app),
		{ id: access.identity.user.id, type: "user" } as const,
	]
	const rows = await db
		.selectFrom("app_connection_assignment")
		.select(["slug", "connection_id", "owner_type", "owner_id"])
		.where("app_id", "=", access.app.id)
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
	return {
		app: access.app,
		connections: Object.entries(resources.connections).map(([slug, requirement]) => {
			const owner = getCredentialOwner(requirement.mode, access.app, access.identity.user)
			const assignment = rows.find(
				(row) =>
					row.slug === slug && row.owner_type === owner.type && row.owner_id === owner.id,
			)
			return {
				connection_id: assignment?.connection_id ?? null,
				mode: requirement.mode,
				slug,
				toolkit: requirement.toolkit,
			}
		}),
	}
}
