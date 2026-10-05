import type { Slate } from "@usecontextlayer/shared/slate"
import { getAgentByName } from "agents/routing"
import type { z } from "zod"
import type { AppAgent } from "@/agent-runtime"
import type { AgentRun, AgentRunRequest, agentSchema } from "@/agents.schema"
import { resolveAppConnection } from "@/app-connections.server"
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

async function readAgent(artifacts: Artifacts, appId: AppId, name: string) {
	using repo = await artifacts.get(appId)
	const [commit] = await repo.log({ limit: 1, ref: "main" })
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
	{ app, identity }: AppAccess,
	agent: z.infer<typeof agentSchema>,
	manifest: Slate,
	{ name, prompt }: AgentRunRequest,
): AgentRun {
	return {
		agent: { commit: agent.commit, instructions: agent.instructions, name },
		appId: app.id,
		connections: {},
		prompt,
		secrets: Object.fromEntries(
			Object.entries(manifest.secrets).map(([secretName, requirement]) => [
				secretName,
				getCredentialOwner(requirement.mode, app, identity.user),
			]),
		),
		viewerId: identity.user.id,
	}
}

export async function getAgentRun(
	db: PlatformDb,
	artifacts: Artifacts,
	apps: DispatchNamespace,
	access: AppAccess,
	issuer: string,
	input: AgentRunRequest,
) {
	const result = await readAgent(artifacts, access.app.id, input.name)
	if (!result.allowed) return result
	const snapshot = await getAppManifest(access.app, apps)
	const run = prepareAgentRun(access, result.agent, snapshot.manifest, input)
	for (const slug of Object.keys(snapshot.manifest.connections)) {
		const resolved = await resolveAppConnection(
			db,
			access,
			issuer,
			slug as AppConnectionAssignmentSlug,
			snapshot,
		)
		if (!resolved.allowed) return resolved
		run.connections[slug] = {
			connection_id: resolved.connection_id,
			owner: resolved.owner,
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
	const agent = await getAgentByName(agents, crypto.randomUUID())
	return agent.start(run)
}

export async function getAgentJob(
	agents: DurableObjectNamespace<AppAgent>,
	app: App,
	name: string,
	id: string,
) {
	const agent = await getAgentByName(agents, id)
	return agent.inspect(app.id, name)
}

export async function startAgentJob(
	db: PlatformDb,
	artifacts: Artifacts,
	apps: DispatchNamespace,
	agents: DurableObjectNamespace<AppAgent>,
	access: AppAccess,
	issuer: string,
	input: AgentRunRequest,
) {
	const prepared = await getAgentRun(db, artifacts, apps, access, issuer, input)
	if (!prepared.allowed) return prepared
	const job = await startAgentRun(agents, prepared.run)
	return { allowed: true, job } as const
}
