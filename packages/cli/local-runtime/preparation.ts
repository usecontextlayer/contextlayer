import type { AgentRunPreparation } from "@usecontextlayer/shared/agent-resources"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { LocalSnapshot } from "@/local-runtime/schema"
import { localAgentRunSchema } from "@/local-runtime/schema"

export function prepareLocalAgentRun(
	snapshot: LocalSnapshot,
	name: string,
	prompt: string,
): AgentRunPreparation {
	const agent = Object.entries(snapshot.agents).find(([key]) => key === name)?.[1]
	if (!agent) return { allowed: false, reason: "agent-definition-missing" }
	const selected = resourcesForConsumer(snapshot.configuration, { name, type: "agent" })
	const connections: Record<string, { account_id: string; toolkit: string }> = {}
	for (const [slug, connection] of Object.entries(selected.connections)) {
		if (connection.account_id === null)
			return { allowed: false, reason: "connection-required", slug }
		connections[slug] = { account_id: connection.account_id, toolkit: connection.toolkit }
	}
	for (const [name, secret] of Object.entries(selected.secrets)) {
		if (secret.value === null) return { allowed: false, name, reason: "secret-required" }
	}
	return {
		allowed: true,
		run: localAgentRunSchema.parse({
			actor: { type: "app" },
			agent: { commit: snapshot.source, instructions: agent.instructions, name },
			connections,
			databases: Object.fromEntries(
				Object.entries(selected.databases).map(([slug, { instance_name }]) => [
					slug,
					{ instance_name },
				]),
			),
			prompt,
			secrets: Object.fromEntries(
				Object.keys(selected.secrets).map((name) => [name, { ref: name }]),
			),
			slateId: snapshot.scope,
		}),
	}
}
