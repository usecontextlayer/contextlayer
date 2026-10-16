import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import { getAgentByName } from "agents/routing"
import { z } from "zod"
import { getAgentInstanceName } from "@/agent-instance"
import type { SlateAgent } from "@/agent-runtime"
import {
	type AgentActor,
	type AgentRun,
	type AgentRunRequest,
	agentJobSchema,
	agentJobSummarySchema,
	type agentSchema,
} from "@/agents.schema"
import { listOrganizations } from "@/auth.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import type { PlatformConfig } from "@/env"
import { readSlateDeclarations } from "@/slate-declarations.server"
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
	{ slate, identity }: OwnerSlateAccess,
	issuer: string,
	name: string,
) {
	const organizations = slate.owner_organization_id
		? await listOrganizations(identity, issuer)
		: []
	// Public viewing does not grant access to authored source.
	const authorization = authorizeSlateManagement(
		slate,
		identity,
		organizations.some((organization) => organization.id === slate.owner_organization_id),
	)
	if (!authorization.allowed) return authorization
	return readAgent(artifacts, slate.id, name)
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
			connection_id: connection.connection_id,
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
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	slate: Slate,
	actor: AgentActor,
	input: AgentRunRequest,
) {
	const snapshot = await readSlateDeclarations(artifacts, slate.id)
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
		databases,
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
) {
	const agent = await getAgentByName(
		agents,
		getAgentInstanceName(run.slateId, run.agent.name, run.actor),
	)
	return agentJobSummarySchema.parse(await agent.start(run, "api"))
}

export async function getAgentJob(
	agents: DurableObjectNamespace<SlateAgent>,
	slate: Slate,
	name: string,
	id: string,
	instanceName: string,
) {
	const agent = await getAgentByName(agents, instanceName)
	return agentJobSchema.nullable().parse(await agent.inspect(slate.id, name, id))
}

export async function listAgentJobs(
	agents: DurableObjectNamespace<SlateAgent>,
	{ slate, identity }: SlateAccess,
	name: string,
) {
	const actors: AgentActor[] = [{ type: "app" }, { id: identity.user.id, type: "user" }]
	const jobs = await Promise.all(
		actors.map(async (actor) => {
			const agent = await getAgentByName(
				agents,
				getAgentInstanceName(slate.id, name, actor),
			)
			return z.array(agentJobSummarySchema).parse(await agent.listJobs(slate.id, name))
		}),
	)
	return jobs
		.flat()
		.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
}

export async function startAgentJob(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: PlatformConfig,
	access: SlateAccess,
	input: AgentRunRequest,
) {
	const prepared = await getAgentRun(
		db,
		artifacts,
		databases,
		agents,
		config,
		access.slate,
		{ id: access.identity.user.id, type: "user" },
		input,
	)
	if (!prepared.allowed) return prepared
	const job = await startAgentRun(agents, prepared.run)
	return { allowed: true, job } as const
}
