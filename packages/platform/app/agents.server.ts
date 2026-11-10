import type {
	ConversationId,
	ConversationQuery,
	Cursor,
	EntryQuery,
	SubmissionId,
	UserInput,
} from "@earendil-works/pi-durable"
import {
	hasViewerResources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/declaration"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import type { SlateAgent } from "@/agent-runtime"
import {
	type AgentActor,
	type AgentConfiguration,
	agentConversationsPageSchema,
	agentConversationViewSchema,
	agentEntriesPageSchema,
	agentRuntimeScheduleSchema,
	type agentSchema,
	agentSubmissionSchema,
} from "@/agents.schema"
import {
	hasPlatformCredential,
	listOrganizations,
	type PlatformCredential,
	type ViewerSessionCredential,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import type { PlatformBindings, PlatformConfig } from "@/env"
import { readLatestSlateDeclarations } from "@/slate-declarations.server"
import { addSlateMember } from "@/slate-members.server"
import {
	getSlateResourceConfiguration,
	type ResolvedSlateResourceConfiguration,
	resolveSlateResourceConfiguration,
} from "@/slate-resource-configuration.server"
import type { Slate } from "@/slates.schema"
import { authorizeSlateManagement, type SlateAccess } from "@/slates.server"

export async function authorizeAgentConversationAccess(
	{ slate, identity }: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	issuer: string,
	actorType: AgentActor["type"],
) {
	if (
		slate.visibility === "public" ||
		(actorType === "app" &&
			(!hasPlatformCredential(identity) ||
				!(await authorizeAgentManagement({ identity, slate }, issuer)).allowed))
	)
		return { allowed: false, reason: "forbidden" } as const
	return { allowed: true } as const
}

export async function getAgent(
	artifacts: Artifacts,
	access: SlateAccess<PlatformCredential>,
	issuer: string,
	name: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	return readAgent(artifacts, access.slate.id, name)
}

async function authorizeAgentManagement(
	{ slate, identity }: SlateAccess<PlatformCredential>,
	issuer: string,
) {
	const organizations = slate.owner_organization_id
		? await listOrganizations(identity, issuer)
		: []
	// Public viewing does not grant access to authored source.
	return authorizeSlateManagement(
		slate,
		identity,
		organizations.some((organization) => organization.id === slate.owner_organization_id),
	)
}

async function readAgent(
	artifacts: Artifacts,
	slateId: SlateId,
	name: string,
	revision = "main",
) {
	using repo = await artifacts.get(slateId)
	const [commit] = await repo.log({ limit: 1, ref: revision })
	if (!commit) return { allowed: false, reason: "not-found" } as const
	const instructions = await repo.readFile({
		path: `agents/${name}/instructions.md`,
		ref: commit.hash,
	})
	if (!instructions) return { allowed: false, reason: "not-found" } as const
	return {
		agent: { commit: commit.hash, instructions: await instructions.text() },
		allowed: true,
	} as const
}

export function prepareAgentConfiguration(
	slate: Slate,
	actor: AgentActor,
	agent: z.infer<typeof agentSchema>,
	configuration: ResolvedSlateResourceConfiguration,
	name: string,
) {
	const connections: AgentConfiguration["connections"] = {}
	for (const [slug, connection] of Object.entries(configuration.connections)) {
		connections[slug] = {
			account_id: connection.account_id,
			owner: connection.owner,
			toolkit: connection.toolkit,
		}
	}
	const configurationValue: AgentConfiguration = {
		actor,
		agent: { commit: agent.commit, instructions: agent.instructions, name },
		connections,
		databases: Object.fromEntries(
			Object.entries(configuration.databases).map(([slug, database]) => [
				slug,
				{ instance_name: database.instance_name, owner: database.owner },
			]),
		),
		secrets: Object.fromEntries(
			Object.entries(configuration.secrets).map(([secretName, requirement]) => [
				secretName,
				requirement.owner,
			]),
		),
		slateId: slate.id,
	}
	return configurationValue
}

export async function getAgentConfiguration(
	db: PlatformDb,
	artifacts: Artifacts,
	config: PlatformBindings,
	slate: Slate,
	actor: AgentActor,
	name: string,
) {
	const snapshot = await readLatestSlateDeclarations(artifacts, slate.id)
	if (!snapshot.allowed)
		return { allowed: false, reason: "agent-definition-missing" } as const
	const result = await readAgent(artifacts, slate.id, name, snapshot.commit)
	if (!result.allowed)
		return { allowed: false, reason: "agent-definition-missing" } as const
	const resources = resourcesForConsumer(snapshot.resources, {
		name,
		type: "agent",
	})
	if (
		hasViewerResources(resources) &&
		(actor.type === "app" || slate.visibility === "public")
	)
		return { allowed: false, reason: "forbidden" } as const
	const configuration = await getSlateResourceConfiguration(
		db,
		config,
		slate,
		actor.type === "user" ? actor : null,
		resources,
	)
	const resolved = resolveSlateResourceConfiguration(configuration)
	if (!resolved.allowed) return resolved
	return {
		allowed: true,
		configuration: prepareAgentConfiguration(
			slate,
			actor,
			result.agent,
			resolved.configuration,
			name,
		),
		snapshot,
	} as const
}

export async function prepareAgentExecution(
	db: PlatformDb,
	artifacts: Artifacts,
	memberProvisioning: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"],
	config: PlatformBindings,
	slate: Slate,
	actor: AgentActor,
	name: string,
) {
	const prepared = await getAgentConfiguration(db, artifacts, config, slate, actor, name)
	if (!prepared.allowed) return prepared
	if (
		actor.type === "user" &&
		hasViewerResources(
			resourcesForConsumer(prepared.snapshot.resources, { name, type: "agent" }),
		)
	) {
		const member = await addSlateMember(
			db,
			memberProvisioning,
			config,
			slate,
			actor,
			prepared.snapshot,
		)
		if (!member.allowed) return member
	}
	return prepared
}

function getAgentActor(access: SlateAccess, type: AgentActor["type"]): AgentActor {
	return type === "app" ? { type } : { id: access.identity.user.id, type }
}

function getAgentInstance(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess,
	name: string,
	actorType: AgentActor["type"],
) {
	return agents.getByName(
		getAgentInstanceName(access.slate.id, name, getAgentActor(access, actorType)),
	)
}

export async function createAgentConversation(
	db: PlatformDb,
	artifacts: Artifacts,
	memberProvisioning: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"],
	agents: DurableObjectNamespace<SlateAgent>,
	config: PlatformConfig,
	access: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	name: string,
	actorType: AgentActor["type"],
) {
	const authorization = await authorizeAgentConversationAccess(
		access,
		config.CTX_AUTH_ISSUER,
		actorType,
	)
	if (!authorization.allowed) return authorization
	const prepared = await prepareAgentExecution(
		db,
		artifacts,
		memberProvisioning,
		config,
		access.slate,
		getAgentActor(access, actorType),
		name,
	)
	if (!prepared.allowed) return prepared
	const conversation = await getAgentInstance(
		agents,
		access,
		name,
		actorType,
	).createConversation(prepared.configuration)
	return { allowed: true, conversation } as const
}

export async function submitAgentInput(
	db: PlatformDb,
	artifacts: Artifacts,
	memberProvisioning: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"],
	agents: DurableObjectNamespace<SlateAgent>,
	config: PlatformConfig,
	access: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	name: string,
	actorType: AgentActor["type"],
	conversationId: ConversationId,
	input: { content: UserInput; requestId?: string },
) {
	const authorization = await authorizeAgentConversationAccess(
		access,
		config.CTX_AUTH_ISSUER,
		actorType,
	)
	if (!authorization.allowed) return authorization
	const prepared = await prepareAgentExecution(
		db,
		artifacts,
		memberProvisioning,
		config,
		access.slate,
		getAgentActor(access, actorType),
		name,
	)
	if (!prepared.allowed) return prepared
	const submission = agentSubmissionSchema
		.optional()
		.parse(
			await getAgentInstance(agents, access, name, actorType).submit(
				conversationId,
				input,
				prepared.configuration,
			),
		)
	return submission
		? ({ allowed: true, submission } as const)
		: ({ allowed: false, reason: "not-found" } as const)
}

export async function getAgentSubmission(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	issuer: string,
	name: string,
	actorType: AgentActor["type"],
	id: SubmissionId,
) {
	const authorization = await authorizeAgentConversationAccess(access, issuer, actorType)
	if (!authorization.allowed) return authorization
	const submission = agentSubmissionSchema
		.optional()
		.parse(await getAgentInstance(agents, access, name, actorType).getSubmission(id))
	return submission
		? ({ allowed: true, submission } as const)
		: ({ allowed: false, reason: "not-found" } as const)
}

export async function listAgentConversations(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	issuer: string,
	name: string,
	actorType: AgentActor["type"],
	query: ConversationQuery,
	limit: number,
	cursor?: Cursor,
) {
	const authorization = await authorizeAgentConversationAccess(access, issuer, actorType)
	if (!authorization.allowed) return authorization
	const conversations = agentConversationsPageSchema.parse(
		await getAgentInstance(agents, access, name, actorType).listConversations(
			query,
			limit,
			cursor,
		),
	)
	return { allowed: true, conversations } as const
}

export async function getAgentConversation(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	issuer: string,
	name: string,
	actorType: AgentActor["type"],
	id: ConversationId,
) {
	const authorization = await authorizeAgentConversationAccess(access, issuer, actorType)
	if (!authorization.allowed) return authorization
	const conversation = agentConversationViewSchema
		.optional()
		.parse(await getAgentInstance(agents, access, name, actorType).getConversation(id))
	return conversation
		? ({ allowed: true, conversation } as const)
		: ({ allowed: false, reason: "not-found" } as const)
}

export async function listAgentEntries(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess<PlatformCredential | ViewerSessionCredential>,
	issuer: string,
	name: string,
	actorType: AgentActor["type"],
	id: ConversationId,
	query: Omit<EntryQuery, "conversationId">,
	limit: number,
	cursor?: Cursor,
) {
	const authorization = await authorizeAgentConversationAccess(access, issuer, actorType)
	if (!authorization.allowed) return authorization
	const entries = agentEntriesPageSchema
		.optional()
		.parse(
			await getAgentInstance(agents, access, name, actorType).entries(
				id,
				query,
				limit,
				cursor,
			),
		)
	return entries
		? ({ allowed: true, entries } as const)
		: ({ allowed: false, reason: "not-found" } as const)
}

export async function listAgentSchedules(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess<PlatformCredential>,
	issuer: string,
	name: string,
	actorType: AgentActor["type"],
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	const schedules = z
		.array(agentRuntimeScheduleSchema)
		.parse(
			await getAgentInstance(agents, access, name, actorType).listAuthoredSchedules(),
		)
	return { allowed: true, schedules } as const
}

export async function getAgentSchedule(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess<PlatformCredential>,
	issuer: string,
	name: string,
	actorType: AgentActor["type"],
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	const schedule = await getAgentInstance(
		agents,
		access,
		name,
		actorType,
	).getAuthoredSchedule(id)
	return {
		allowed: true,
		schedule: schedule ? agentRuntimeScheduleSchema.parse(schedule) : null,
	} as const
}
