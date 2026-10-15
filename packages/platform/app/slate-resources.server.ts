import {
	type CredentialMode,
	hasViewerResources,
	type Resources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/declaration"
import type { SlateResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { AgentActor } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateConnectionAssignmentSlug } from "@/database/models/public/SlateConnectionAssignment"
import { getCredentialOwner, getSlateOwner } from "@/owner"
import { listSharedSecretNames, secretKey } from "@/secrets.server"
import { getSlateConnectionAssignments } from "@/slate-connections.server"
import {
	readSlateDeclarations,
	type SlateDeclarationSnapshot,
} from "@/slate-declarations.server"
import { addSlateMember, isSlateMember } from "@/slate-members.server"
import type { Slate } from "@/slates.schema"
import type { OwnerSlateAccess, SlateAccess } from "@/slates.server"

export function resolveSlateResourceConfiguration(
	configuration: SlateResourceConfiguration,
	secretNames: ReadonlySet<string>,
) {
	const connections: Record<
		string,
		SlateResourceConfiguration["connections"][string] & { connection_id: string }
	> = {}
	for (const [slug, connection] of Object.entries(configuration.connections)) {
		if (connection.connection_id === null)
			return { allowed: false, reason: "connection-required", slug } as const
		connections[slug] = { ...connection, connection_id: connection.connection_id }
	}
	for (const [name, secret] of Object.entries(configuration.secrets)) {
		if (secret.mode === "viewer" && !secretNames.has(secretKey(secret.owner, name)))
			return { allowed: false, name, reason: "secret-required" } as const
	}
	return { allowed: true, configuration: { ...configuration, connections } } as const
}

export type ResolvedSlateResourceConfiguration = Extract<
	ReturnType<typeof resolveSlateResourceConfiguration>,
	{ allowed: true }
>["configuration"]

export async function prepareSlateResourceExecution(
	db: PlatformDb,
	bindings: PlatformEnv["Bindings"],
	slate: Slate,
	actor: AgentActor,
	snapshot: SlateDeclarationSnapshot,
	resources: Resources,
) {
	const user = actor.type === "user" ? actor : null
	if ((!user || slate.visibility === "public") && hasViewerResources(resources))
		return { allowed: false, reason: "forbidden" } as const
	const joining =
		user !== null &&
		slate.visibility === "private" &&
		!(await isSlateMember(db, slate.id, user))
	const configuration = await getSlateResourceConfiguration(
		db,
		slate,
		user,
		joining ? snapshot.resources : resources,
	)
	const secretNames = Object.values(configuration.secrets).some(
		(secret) => secret.mode === "viewer",
	)
		? await listSharedSecretNames(bindings)
		: new Set<string>()
	const resolved = resolveSlateResourceConfiguration(configuration, secretNames)
	if (!resolved.allowed) return resolved
	if (joining)
		await addSlateMember(
			db,
			bindings.ARTIFACTS,
			bindings.DATABASES,
			bindings.AGENTS,
			slate,
			user,
			snapshot,
		)
	return {
		allowed: true,
		configuration: {
			connections: Object.fromEntries(
				Object.entries(resolved.configuration.connections).filter(
					([slug]) => slug in resources.connections,
				),
			),
			databases: Object.fromEntries(
				Object.entries(resolved.configuration.databases).filter(
					([slug]) => slug in resources.databases,
				),
			),
			secrets: Object.fromEntries(
				Object.entries(resolved.configuration.secrets).filter(
					([name]) => name in resources.secrets,
				),
			),
		},
	} as const
}

export function getSlateResources(access: SlateAccess, artifacts: Artifacts) {
	return readSlateDeclarations(artifacts, access.slate.id)
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
	bindings: PlatformEnv["Bindings"],
	access: SlateAccess,
	slug: SlateConnectionAssignmentSlug,
	snapshot: SlateDeclarationSnapshot,
) {
	const selected = resourcesForConsumer(snapshot.resources, { type: "app" })
	const declared = selected.connections[slug]
	if (!declared) return { allowed: false, reason: "not-declared" } as const
	const resolved = await prepareSlateResourceExecution(
		db,
		bindings,
		access.slate,
		{ id: access.identity.user.id, type: "user" },
		snapshot,
		{
			connections: { [slug]: declared },
			databases: {},
			secrets: {},
		},
	)
	if (!resolved.allowed) return resolved
	const connection = resolved.configuration.connections[
		slug
	] as ResolvedSlateResourceConfiguration["connections"][string]
	const { connection_id, owner, ...requirement } = connection
	return { allowed: true, connection_id, owner, requirement } as const
}
