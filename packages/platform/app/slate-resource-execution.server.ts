import {
	hasViewerResources,
	type Resources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/declaration"
import type { AgentActor } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateConnectionAssignmentSlug } from "@/database/models/public/SlateConnectionAssignment"
import type { PlatformConfig } from "@/env"
import {
	readLatestSlateDeclarations,
	type SlateDeclarationSnapshot,
} from "@/slate-declarations.server"
import { addSlateMember } from "@/slate-members.server"
import {
	getSlateResourceConfiguration,
	type ResolvedSlateResourceConfiguration,
	resolveSlateResourceConfiguration,
} from "@/slate-resource-configuration.server"
import type { Slate } from "@/slates.schema"
import type { SlateAccess } from "@/slates.server"

export async function prepareSlateResourceExecution(
	db: PlatformDb,
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	slate: Slate,
	actor: AgentActor,
	snapshot: SlateDeclarationSnapshot,
	resources: Resources,
) {
	const user = actor.type === "user" ? actor : null
	if (hasViewerResources(resources)) {
		if (!user || slate.visibility === "public")
			return { allowed: false, reason: "forbidden" } as const
		const member = await addSlateMember(
			db,
			artifacts,
			sandbox,
			agents,
			config,
			slate,
			user,
			snapshot,
		)
		if (!member.allowed) return member
	}
	const configuration = await getSlateResourceConfiguration(
		db,
		config,
		slate,
		user,
		resources,
	)
	return resolveSlateResourceConfiguration(configuration)
}

export function getSlateResources(access: SlateAccess, artifacts: Artifacts) {
	return readLatestSlateDeclarations(artifacts, access.slate.id)
}

export async function resolveSlateConnection(
	db: PlatformDb,
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	access: SlateAccess,
	slug: SlateConnectionAssignmentSlug,
	snapshot: SlateDeclarationSnapshot,
) {
	const selected = resourcesForConsumer(snapshot.resources, { type: "app" })
	const declared = selected.connections[slug]
	if (!declared) return { allowed: false, reason: "not-declared" } as const
	const resolved = await prepareSlateResourceExecution(
		db,
		artifacts,
		sandbox,
		agents,
		config,
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
