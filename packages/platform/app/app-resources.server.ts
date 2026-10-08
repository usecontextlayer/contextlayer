import type { AppResourceConfiguration } from "@usecontextlayer/shared/app-resources"
import {
	type CredentialMode,
	hasViewerResources,
	type Resources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/slate"
import { getAppConnectionAssignments } from "@/app-connections.server"
import { readAppDeclarations } from "@/app-declarations.server"
import { type AppActor, getAppActor } from "@/app-members.server"
import type { App } from "@/apps.schema"
import type { AppAccess } from "@/apps.server"
import type { PlatformDb } from "@/database"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"
import { getAppOwner, getCredentialOwner } from "@/owner"

export function resolveAppResourceActor(actor: AppActor, resources: Resources) {
	if (actor.type !== "member" && hasViewerResources(resources))
		return { allowed: false, reason: "membership-required" } as const
	return { allowed: true, viewer: actor.type === "app" ? null : actor } as const
}

export async function getAppResources(access: AppAccess, artifacts: Artifacts) {
	const snapshot = await readAppDeclarations(artifacts, access.app.id)
	if (snapshot.state === "no-commit")
		throw new Error("App repository main commit not found")
	return snapshot.resources
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
		databases: prepareAppDatabaseConfiguration(app, viewer, resources.databases),
		secrets: withOwners(resources.secrets),
	}
}

export function prepareAppDatabaseConfiguration(
	app: App,
	viewer: { id: string } | null,
	requirements: Resources["databases"],
) {
	return Object.fromEntries(
		Object.entries(requirements).map(([slug, requirement]) => [
			slug,
			prepareAppDatabase(app, viewer, slug, requirement),
		]),
	)
}

export function prepareAppDatabase(
	app: App,
	viewer: { id: string } | null,
	slug: string,
	requirement: Resources["databases"][string],
) {
	const owner = getCredentialOwner(requirement.mode, app, viewer)
	const instance_name = JSON.stringify([app.id, owner.type, owner.id, slug])
	return { ...requirement, instance_name, owner }
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
	const selected = resourcesForConsumer(resources, { type: "app" })
	const declared = selected.connections[slug]
	if (!declared) return { allowed: false, reason: "not-declared" } as const
	const actor = await getAppActor(db, access.app.id, access.identity.user)
	const required = {
		connections: { [slug]: declared },
		databases: {},
		secrets: {},
	}
	const resolved = resolveAppResourceActor(actor, required)
	if (!resolved.allowed) return resolved
	const configuration = await getAppResourceConfiguration(
		db,
		access.app,
		resolved.viewer,
		required,
	)
	const connection = configuration.connections[slug]
	if (!connection || connection.connection_id === null)
		return { allowed: false, reason: "not-found" } as const
	const { connection_id, owner, ...requirement } = connection
	return { allowed: true, connection_id, owner, requirement } as const
}
