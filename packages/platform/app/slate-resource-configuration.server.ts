import type { Resources } from "@usecontextlayer/shared/declaration"
import type { SlateResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { getCredentialOwner, getSlateOwner, type Owner } from "@/owner"
import { listSharedSecretNames, secretKey } from "@/secrets.server"
import { assignmentOwner } from "@/slate-connections.schema"
import type { Slate } from "@/slates.schema"
import type { OwnerSlateAccess } from "@/slates.server"

export function resolveSlateResourceConfiguration(
	configuration: SlateResourceConfiguration,
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
		if (secret.mode === "viewer" && !secret.supplied)
			return { allowed: false, name, reason: "secret-required" } as const
	}
	return { allowed: true, configuration: { ...configuration, connections } } as const
}

export type ResolvedSlateResourceConfiguration = Extract<
	ReturnType<typeof resolveSlateResourceConfiguration>,
	{ allowed: true }
>["configuration"]

export function prepareSlateResourceConfiguration(
	slate: Slate,
	viewer: { id: string } | null,
	resources: Resources,
	assignments: Awaited<ReturnType<typeof getSlateConnectionAssignments>>,
	secretNames: ReadonlySet<string>,
): SlateResourceConfiguration {
	return {
		connections: Object.fromEntries(
			Object.entries(resources.connections).map(([slug, requirement]) => [
				slug,
				prepareSlateConnection(slate, viewer, slug, requirement, assignments),
			]),
		),
		databases: prepareSlateDatabaseConfiguration(slate, viewer, resources.databases),
		secrets: Object.fromEntries(
			Object.entries(resources.secrets).map(([name, requirement]) => {
				const owner = getCredentialOwner(requirement.mode, slate, viewer)
				return [
					name,
					requirement.mode === "viewer"
						? {
								...requirement,
								mode: requirement.mode,
								owner,
								supplied: secretNames.has(secretKey(owner, name)),
							}
						: { ...requirement, mode: requirement.mode, owner },
				]
			}),
		),
	}
}

function prepareSlateConnection(
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
	config: PlatformConfig,
	slate: Slate,
	viewer: { id: string } | null,
	resources: Resources,
) {
	const [assignments, secretNames] = await Promise.all([
		getSlateConnectionAssignments(db, slate.id, [
			getSlateOwner(slate),
			...(viewer ? [{ id: viewer.id, type: "personal" } as const] : []),
		]),
		Object.values(resources.secrets).some(({ mode }) => mode === "viewer")
			? listSharedSecretNames(config)
			: new Set<string>(),
	])
	return prepareSlateResourceConfiguration(
		slate,
		viewer,
		resources,
		assignments,
		secretNames,
	)
}

function getSlateConnectionAssignments(
	db: PlatformDb,
	slateId: Slate["id"],
	owners: Owner[],
) {
	return db
		.selectFrom("slate_connection_assignment")
		.select(["slug", "connection_id", "owner_type", "owner_id"])
		.where("slate_id", "=", slateId)
		.where((eb) => eb.or(owners.map((owner) => eb.and(assignmentOwner(owner)))))
		.execute()
}

export async function listSlateResources(
	db: PlatformDb,
	config: PlatformConfig,
	access: OwnerSlateAccess,
	resources: Resources,
) {
	return {
		resources: await getSlateResourceConfiguration(
			db,
			config,
			access.slate,
			access.identity.user,
			resources,
		),
		slate: access.slate,
	}
}

export async function listSlateConnections(
	db: PlatformDb,
	config: PlatformConfig,
	access: OwnerSlateAccess,
	resources: Resources,
) {
	const configured = await listSlateResources(db, config, access, {
		connections: resources.connections,
		databases: {},
		secrets: {},
	})
	return {
		connections: Object.entries(configured.resources.connections).map(
			([slug, connection]) => ({ ...connection, slug }),
		),
		slate: configured.slate,
	}
}
