import {
	type CredentialMode,
	hasViewerResources,
	type Resources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/declaration"
import type { SlateResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { PlatformDb } from "@/database"
import type { SlateConnectionAssignmentSlug } from "@/database/models/public/SlateConnectionAssignment"
import { getCredentialOwner, getSlateOwner } from "@/owner"
import { getSlateConnectionAssignments } from "@/slate-connections.server"
import { readSlateDeclarations } from "@/slate-declarations.server"
import { getSlateActor, type SlateActor } from "@/slate-members.server"
import type { Slate } from "@/slates.schema"
import type { OwnerSlateAccess, SlateAccess } from "@/slates.server"

export function resolveSlateResourceActor(actor: SlateActor, resources: Resources) {
	if (actor.type !== "member" && hasViewerResources(resources))
		return { allowed: false, reason: "membership-required" } as const
	return { allowed: true, viewer: actor.type === "app" ? null : actor } as const
}

export async function getSlateResources(access: SlateAccess, artifacts: Artifacts) {
	const snapshot = await readSlateDeclarations(artifacts, access.slate.id)
	if (snapshot.state === "no-commit")
		throw new Error("Slate repository main commit not found")
	return snapshot.resources
}

export function prepareSlateResourceConfiguration(
	slate: Slate,
	viewer: { id: string } | null,
	resources: Resources,
	assignments: Awaited<ReturnType<typeof getSlateConnectionAssignments>>,
): SlateResourceConfiguration {
	function withOwners<T extends { mode: CredentialMode }>(
		requirements: Record<string, T>,
	) {
		return Object.fromEntries(
			Object.entries(requirements).map(([name, requirement]) => [
				name,
				{
					...requirement,
					owner: getCredentialOwner(requirement.mode, slate, viewer),
				},
			]),
		)
	}
	return {
		connections: Object.fromEntries(
			Object.entries(resources.connections).map(([slug, requirement]) => [
				slug,
				prepareSlateConnection(slate, viewer, slug, requirement, assignments),
			]),
		),
		databases: prepareSlateDatabaseConfiguration(slate, viewer, resources.databases),
		secrets: withOwners(resources.secrets),
	}
}

export function prepareSlateConnection(
	slate: Slate,
	viewer: { id: string } | null,
	slug: string,
	requirement: Resources["connections"][string],
	assignments: Awaited<ReturnType<typeof getSlateConnectionAssignments>>,
) {
	const owner = getCredentialOwner(requirement.mode, slate, viewer)
	const assignment = assignments.find(
		(row) =>
			row.slug === slug && row.owner_type === owner.type && row.owner_id === owner.id,
	)
	return { ...requirement, connection_id: assignment?.connection_id ?? null, owner }
}

export function prepareSlateDatabaseConfiguration(
	slate: Slate,
	viewer: { id: string } | null,
	requirements: Resources["databases"],
) {
	return Object.fromEntries(
		Object.entries(requirements).map(([slug, requirement]) => [
			slug,
			prepareSlateDatabase(slate, viewer, slug, requirement),
		]),
	)
}

export function prepareSlateDatabase(
	slate: Slate,
	viewer: { id: string } | null,
	slug: string,
	requirement: Resources["databases"][string],
) {
	const owner = getCredentialOwner(requirement.mode, slate, viewer)
	const instance_name = JSON.stringify([slate.id, owner.type, owner.id, slug])
	return { ...requirement, instance_name, owner }
}

export async function getSlateResourceConfiguration(
	db: PlatformDb,
	slate: Slate,
	viewer: { id: string } | null,
	resources: Resources,
) {
	const assignments = await getSlateResourceAssignments(db, slate, viewer)
	return prepareSlateResourceConfiguration(slate, viewer, resources, assignments)
}

function getSlateResourceAssignments(
	db: PlatformDb,
	slate: Slate,
	viewer: { id: string } | null,
) {
	return getSlateConnectionAssignments(db, slate.id, [
		getSlateOwner(slate),
		...(viewer ? [{ id: viewer.id, type: "personal" } as const] : []),
	])
}

export async function listSlateResources(
	db: PlatformDb,
	access: OwnerSlateAccess,
	resources: Resources,
) {
	return {
		resources: await getSlateResourceConfiguration(
			db,
			access.slate,
			access.identity.user,
			resources,
		),
		slate: access.slate,
	}
}

export async function listSlateConnections(
	db: PlatformDb,
	access: OwnerSlateAccess,
	resources: Resources,
) {
	const configured = await listSlateResources(db, access, resources)
	return {
		connections: Object.entries(configured.resources.connections).map(
			([slug, connection]) => ({ ...connection, slug }),
		),
		slate: configured.slate,
	}
}

export async function resolveSlateConnection(
	db: PlatformDb,
	access: SlateAccess,
	slug: SlateConnectionAssignmentSlug,
	resources: Resources,
) {
	const selected = resourcesForConsumer(resources, { type: "app" })
	const declared = selected.connections[slug]
	if (!declared) return { allowed: false, reason: "not-declared" } as const
	const actor = await getSlateActor(db, access.slate.id, access.identity.user)
	const resolved = resolveSlateResourceActor(actor, {
		connections: { [slug]: declared },
		databases: {},
		secrets: {},
	})
	if (!resolved.allowed) return resolved
	const assignments = await getSlateResourceAssignments(db, access.slate, resolved.viewer)
	const connection = prepareSlateConnection(
		access.slate,
		resolved.viewer,
		slug,
		declared,
		assignments,
	)
	if (connection.connection_id === null)
		return { allowed: false, reason: "connection-required", slug } as const
	const { connection_id, owner, ...requirement } = connection
	return { allowed: true, connection_id, owner, requirement } as const
}
