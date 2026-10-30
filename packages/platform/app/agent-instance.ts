import { hasViewerResources, type Resources } from "@usecontextlayer/shared/declaration"
import type { AgentActor } from "@/agents.schema"
import type { SlateId } from "@/database/models/public/Slate"

export function getAgentInstanceName(slateId: SlateId, name: string, actor: AgentActor) {
	return JSON.stringify([
		slateId,
		name,
		actor.type,
		actor.type === "user" ? actor.id : null,
	])
}

export function getAgentUnattendedScope(resources: Resources) {
	return hasViewerResources(resources) ? "member" : "app"
}
