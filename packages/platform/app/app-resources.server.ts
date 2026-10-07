import type { AppResourceConfiguration } from "@usecontextlayer/shared/app-resources"
import type { CredentialMode, Resources } from "@usecontextlayer/shared/slate"
import { getAppConnectionAssignments } from "@/app-connections.server"
import { readAppDeclarations } from "@/app-declarations.server"
import type { App } from "@/apps.schema"
import type { AppAccess } from "@/apps.server"
import type { PlatformDb } from "@/database"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"
import { getAppOwner, getCredentialOwner } from "@/owner"

export async function getAppResources(access: AppAccess, artifacts: Artifacts) {
	const { resources } = await readAppDeclarations(artifacts, access.app.id)
	return resources
}

export function prepareAppResourceConfiguration(
	app: App,
	viewer: { id: string } | null,
	resources: Resources,
	assignments: Awaited<ReturnType<typeof getAppConnectionAssignments>>,
): AppResourceConfiguration {
	function withOwners<T extends { mode: CredentialMode }>(
		requirements: Record<string, T>,
	) {
		return Object.fromEntries(
			Object.entries(requirements).map(([name, requirement]) => [
				name,
				{
					...requirement,
					owner: getCredentialOwner(requirement.mode, app, viewer),
				},
			]),
		)
	}
	return {
		connections: Object.fromEntries(
			Object.entries(withOwners(resources.connections)).map(([slug, requirement]) => {
				const assignment = assignments.find(
					(row) =>
						row.slug === slug &&
						row.owner_type === requirement.owner.type &&
						row.owner_id === requirement.owner.id,
				)
				return [
					slug,
					{ ...requirement, connection_id: assignment?.connection_id ?? null },
				]
			}),
		),
		folders: withOwners(resources.folders),
		secrets: withOwners(resources.secrets),
	}
}

export async function getAppResourceConfiguration(
	db: PlatformDb,
	app: App,
	viewer: { id: string } | null,
	resources: Resources,
) {
	const assignments = await getAppConnectionAssignments(db, app.id, [
		getAppOwner(app),
		...(viewer ? [{ id: viewer.id, type: "user" } as const] : []),
	])
	return prepareAppResourceConfiguration(app, viewer, resources, assignments)
}

export async function listAppResources(
	db: PlatformDb,
	access: AppAccess,
	resources: Resources,
) {
	return {
		app: access.app,
		resources: await getAppResourceConfiguration(
			db,
			access.app,
			access.identity.user,
			resources,
		),
	}
}

export async function listAppConnections(
	db: PlatformDb,
	access: AppAccess,
	resources: Resources,
) {
	const configured = await listAppResources(db, access, resources)
	return {
		app: configured.app,
		connections: Object.entries(configured.resources.connections).map(
			([slug, connection]) => ({ ...connection, slug }),
		),
	}
}

export async function resolveAppConnection(
	db: PlatformDb,
	access: AppAccess,
	slug: AppConnectionAssignmentSlug,
	resources: Resources,
) {
	const configuration = await getAppResourceConfiguration(
		db,
		access.app,
		access.identity.user,
		resources,
	)
	const connection = configuration.connections[slug]
	if (!connection || connection.connection_id === null)
		return { allowed: false, reason: "not-found" } as const
	const { connection_id, owner, ...requirement } = connection
	return { allowed: true, connection_id, owner, requirement } as const
}
