import type { Slate } from "@usecontextlayer/shared/slate"
import { getAgentByName } from "agents/routing"
import type { z } from "zod"
import type { AppAgent } from "@/agent-runtime"
import type { AgentActor, AgentRun, AgentRunRequest, agentSchema } from "@/agents.schema"
import { getAppConnectionAssignment } from "@/app-connections.server"
import type { App } from "@/apps.schema"
import { type AppAccess, authorizeAppManagement } from "@/apps.server"
import { listOrganizations } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"
import { getAppManifest } from "@/manifest.server"
import { getCredentialOwner } from "@/owner"

export async function getAgent(
	artifacts: Artifacts,
	{ app, identity }: AppAccess,
	issuer: string,
	name: string,
) {
	const organizations = app.owner_organization_id
		? await listOrganizations(identity, issuer)
		: []
	// Public viewing does not grant access to authored source.
	const authorization = authorizeAppManagement(
		app,
		identity,
		organizations.some((organization) => organization.id === app.owner_organization_id),
	)
	if (!authorization.allowed) return authorization
	return readAgent(artifacts, app.id, name)
}

async function readAgent(
	artifacts: Artifacts,
	appId: AppId,
	name: string,
	revision = "main",
) {
	using repo = await artifacts.get(appId)
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
	app: App,
	actor: AgentActor,
	agent: z.infer<typeof agentSchema>,
	manifest: Slate,
	{ name, prompt }: AgentRunRequest,
): AgentRun {
	return {
		actor,
		agent: { commit: agent.commit, instructions: agent.instructions, name },
		appId: app.id,
		connections: {},
		prompt,
		secrets: Object.fromEntries(
			Object.entries(manifest.secrets).map(([secretName, requirement]) => [
				secretName,
				getCredentialOwner(requirement.mode, app, actor.type === "user" ? actor : null),
			]),
		),
	}
}

export async function getAgentRun(
	db: PlatformDb,
	artifacts: Artifacts,
	apps: DispatchNamespace,
	app: App,
	actor: AgentActor,
	input: AgentRunRequest,
	revision = "main",
) {
	const result = await readAgent(artifacts, app.id, input.name, revision)
	if (!result.allowed) return result
	const snapshot = await getAppManifest(app, apps)
	const run = prepareAgentRun(app, actor, result.agent, snapshot.manifest, input)
	for (const [slug, requirement] of Object.entries(snapshot.manifest.connections)) {
		const owner = getCredentialOwner(
			requirement.mode,
			app,
			actor.type === "user" ? actor : null,
		)
		const assignment = await getAppConnectionAssignment(
			db,
			app.id,
			owner,
			slug as AppConnectionAssignmentSlug,
		)
		if (!assignment) return { allowed: false, reason: "not-found" } as const
		run.connections[slug] = {
			connection_id: assignment.connection_id,
			owner,
		}
	}
	return {
		allowed: true,
		run,
	} as const
}

export async function startAgentRun(
	agents: DurableObjectNamespace<AppAgent>,
	run: AgentRun,
) {
	const agent = await getAgentByName(
		agents,
		getAgentInstanceName(run.appId, run.agent.name, run.actor),
	)
	return agent.start(run, "api")
}

export function getAgentInstanceName(appId: AppId, name: string, actor: AgentActor) {
	return JSON.stringify([
		appId,
		name,
		actor.type,
		actor.type === "user" ? actor.id : null,
	])
}

export async function getAgentJob(
	agents: DurableObjectNamespace<AppAgent>,
	app: App,
	name: string,
	id: string,
	instanceName: string,
) {
	const agent = await getAgentByName(agents, instanceName)
	return agent.inspect(app.id, name, id)
}

export async function listAgentJobs(
	agents: DurableObjectNamespace<AppAgent>,
	app: App,
	name: string,
) {
	const agent = await getAgentByName(
		agents,
		getAgentInstanceName(app.id, name, { type: "app" }),
	)
	return agent.listJobs(app.id, name)
}

export async function startAgentJob(
	db: PlatformDb,
	artifacts: Artifacts,
	apps: DispatchNamespace,
	agents: DurableObjectNamespace<AppAgent>,
	access: AppAccess,
	input: AgentRunRequest,
) {
	const prepared = await getAgentRun(
		db,
		artifacts,
		apps,
		access.app,
		{ id: access.identity.user.id, type: "user" },
		input,
	)
	if (!prepared.allowed) return prepared
	const job = await startAgentRun(agents, prepared.run)
	return { allowed: true, job } as const
}
