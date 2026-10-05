import type { Slate } from "@usecontextlayer/shared/slate"
import type { z } from "zod"
import type { AgentRun, AgentRunRequest, agentSchema } from "@/agents.schema"
import { type AppAccess, authorizeAppManagement } from "@/apps.server"
import { listOrganizations } from "@/auth.server"
import type { AppId } from "@/database/models/public/App"
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
	const authorization = authorizeAppManagement(app, identity, organizations)
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
	artifacts: Artifacts,
	access: AppAccess,
	input: AgentRunRequest,
) {
	const result = await readAgent(artifacts, access.app.id, input.name)
	if (!result.allowed) return result
	const manifest = await getAppManifest(access)
	return {
		allowed: true,
		run: prepareAgentRun(access, result.agent, manifest, input),
	} as const
}
