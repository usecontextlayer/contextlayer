import type { Resources } from "@usecontextlayer/shared/slate"
import type { AgentActor } from "@/agents.schema"
import type { AppId } from "@/database/models/public/App"

export function getAgentInstanceName(appId: AppId, name: string, actor: AgentActor) {
	return JSON.stringify([
		appId,
		name,
		actor.type,
		actor.type === "user" ? actor.id : null,
	])
}

export function getAgentUnattendedScope(resources: Resources) {
	return Object.values(resources).some((requirements) =>
		Object.values(requirements).some(({ mode }) => mode === "viewer"),
	)
		? "member"
		: "app"
}
