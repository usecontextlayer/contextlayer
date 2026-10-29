import type { AgentActor } from "@/lib/agents"

export { getAgentByName } from "agents/routing"

export function getAgentInstanceName(slateId: string, name: string, actor: AgentActor) {
	return JSON.stringify([
		slateId,
		name,
		actor.type,
		actor.type === "user" ? actor.id : null,
	])
}
