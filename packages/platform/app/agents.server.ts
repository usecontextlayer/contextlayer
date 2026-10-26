import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import { getAgentByName } from "agents/routing"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import type { SlateAgent } from "@/agent-runtime"
import {
	type AgentActor,
	type AgentJobTrigger,
	type AgentRun,
	type AgentRunRequest,
	agentJobInspectionSchema,
	agentJobMessageSchema,
	agentRuntimeScheduleSchema,
	type agentSchema,
} from "@/agents.schema"
import { listOrganizations } from "@/auth.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import type { PlatformConfig } from "@/env"
import { readLatestSlateDeclarations } from "@/slate-declarations.server"
import type { ResolvedSlateResourceConfiguration } from "@/slate-resource-configuration.server"
import { prepareSlateResourceExecution } from "@/slate-resource-execution.server"
import type { Slate } from "@/slates.schema"
import {
	authorizeSlateManagement,
	type OwnerSlateAccess,
	type SlateAccess,
} from "@/slates.server"

export async function getAgent(
	artifacts: Artifacts,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	return readAgent(artifacts, access.slate.id, name)
}

async function authorizeAgentManagement(
	{ slate, identity }: OwnerSlateAccess,
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

export function prepareAgentRun(
	slate: Slate,
	actor: AgentActor,
	agent: z.infer<typeof agentSchema>,
	configuration: ResolvedSlateResourceConfiguration,
	{ name, prompt }: AgentRunRequest,
) {
	const connections: AgentRun["connections"] = {}
	for (const [slug, connection] of Object.entries(configuration.connections)) {
		connections[slug] = {
			account_id: connection.account_id,
			owner: connection.owner,
			toolkit: connection.toolkit,
		}
	}
	const run: AgentRun = {
		actor,
		agent: { commit: agent.commit, instructions: agent.instructions, name },
		connections,
		databases: Object.fromEntries(
			Object.entries(configuration.databases).map(([slug, database]) => [
				slug,
				{ instance_name: database.instance_name, owner: database.owner },
			]),
		),
		prompt,
		secrets: Object.fromEntries(
			Object.entries(configuration.secrets).map(([secretName, requirement]) => [
				secretName,
				requirement.owner,
			]),
		),
		slateId: slate.id,
	}
	return run
}

export async function getAgentRun(
	db: PlatformDb,
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	slate: Slate,
	actor: AgentActor,
	input: AgentRunRequest,
) {
	const snapshot = await readLatestSlateDeclarations(artifacts, slate.id)
	if (!snapshot.allowed)
		return { allowed: false, reason: "agent-definition-missing" } as const
	const result = await readAgent(artifacts, slate.id, input.name, snapshot.commit)
	if (!result.allowed)
		return { allowed: false, reason: "agent-definition-missing" } as const
	const resources = resourcesForConsumer(snapshot.resources, {
		name: input.name,
		type: "agent",
	})
	const resolved = await prepareSlateResourceExecution(
		db,
		artifacts,
		sandbox,
		agents,
		config,
		slate,
		actor,
		snapshot,
		resources,
	)
	if (!resolved.allowed) return resolved
	return {
		allowed: true,
		run: prepareAgentRun(slate, actor, result.agent, resolved.configuration, input),
	} as const
}

export async function startAgentRun(
	agents: DurableObjectNamespace<SlateAgent>,
	run: AgentRun,
	trigger: AgentJobTrigger = { type: "api" },
) {
	const agent = await getAgentByName(
		agents,
		getAgentInstanceName(run.slateId, run.agent.name, run.actor),
	)
	return agent.start(run, trigger)
}

function getAgentScopes(
	agents: DurableObjectNamespace<SlateAgent>,
	{ slate, identity }: SlateAccess,
	name: string,
) {
	const actors: AgentActor[] = [{ type: "app" }, { id: identity.user.id, type: "user" }]
	return Promise.all(
		actors.map((actor) =>
			getAgentByName(agents, getAgentInstanceName(slate.id, name, actor)),
		),
	)
}

export async function getAgentJob(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess,
	name: string,
	id: string,
) {
	for (const agent of await getAgentScopes(agents, access, name)) {
		const job = await agent.getJob(id)
		if (job) return job
	}
	return null
}

async function resolveAgentJob(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess,
	name: string,
	id: string,
) {
	for (const agent of await getAgentScopes(agents, access, name)) {
		const job = await agent.resolveJob(id)
		if (job) return job
	}
	return null
}

export async function getAgentJobOperation(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess,
	name: string,
	id: string,
) {
	using job = await resolveAgentJob(agents, access, name, id)
	return job ? await job.operation() : null
}

export async function getAgentJobResult(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess,
	name: string,
	id: string,
) {
	using job = await resolveAgentJob(agents, access, name, id)
	return job ? await job.result() : null
}

export async function listAgentJobs(
	agents: DurableObjectNamespace<SlateAgent>,
	access: SlateAccess,
	name: string,
	schedule?: string,
) {
	const scopes = await getAgentScopes(agents, access, name)
	const jobs = await Promise.all(scopes.map((agent) => agent.listJobs()))
	return jobs
		.flat()
		.filter(
			(job) =>
				schedule === undefined ||
				(job.metadata?.trigger.type === "schedule" &&
					job.metadata.trigger.schedule === schedule),
		)
		.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

export async function listAgentJobSessions(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	using job = await resolveAgentJob(agents, access, name, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return { allowed: true, sessions: await job.listSessions() } as const
}

export async function getAgentJobMessages(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
	session: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	using job = await resolveAgentJob(agents, access, name, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	const messages = await job.messages(session)
	if (messages === null) return { allowed: false, reason: "not-found" } as const
	return {
		allowed: true,
		messages: z.array(agentJobMessageSchema).parse(messages),
	} as const
}

export async function getAgentJobUsage(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	using job = await resolveAgentJob(agents, access, name, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return { allowed: true, usage: await job.usage() } as const
}

export async function getAgentJobInspection(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	using job = await resolveAgentJob(agents, access, name, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return {
		allowed: true,
		inspection: agentJobInspectionSchema.parse(await job.inspection()),
	} as const
}

export async function abortAgentJob(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	using job = await resolveAgentJob(agents, access, name, id)
	if (!job) return { allowed: false, reason: "not-found" } as const
	return { allowed: true, result: await job.abort() } as const
}

export async function deleteAgentJob(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	for (const agent of await getAgentScopes(agents, access, name)) {
		if (await agent.deleteJob(id)) return { allowed: true } as const
	}
	return { allowed: false, reason: "not-found" } as const
}

export async function listAgentSchedules(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	const scopes = await getAgentScopes(agents, access, name)
	const schedules = await Promise.all(
		scopes.map(async (agent) =>
			z.array(agentRuntimeScheduleSchema).parse(await agent.listAuthoredSchedules()),
		),
	)
	return { allowed: true, schedules: schedules.flat() } as const
}

export async function getAgentSchedule(
	agents: DurableObjectNamespace<SlateAgent>,
	access: OwnerSlateAccess,
	issuer: string,
	name: string,
	id: string,
) {
	const authorization = await authorizeAgentManagement(access, issuer)
	if (!authorization.allowed) return authorization
	for (const agent of await getAgentScopes(agents, access, name)) {
		const schedule = await agent.getAuthoredSchedule(id)
		if (schedule)
			return {
				allowed: true,
				schedule: agentRuntimeScheduleSchema.parse(schedule),
			} as const
	}
	return { allowed: true, schedule: null } as const
}

export async function startAgentJob(
	db: PlatformDb,
	artifacts: Artifacts,
	sandbox: PlatformEnv["Bindings"]["SANDBOX"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	access: SlateAccess,
	input: AgentRunRequest,
) {
	const prepared = await getAgentRun(
		db,
		artifacts,
		sandbox,
		agents,
		config,
		access.slate,
		{ id: access.identity.user.id, type: "user" },
		input,
	)
	if (!prepared.allowed) return prepared
	const creation = await startAgentRun(agents, prepared.run)
	return { allowed: true, creation } as const
}
