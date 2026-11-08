import { hasViewerResources, type Resources } from "@usecontextlayer/shared/declaration"
import { z } from "zod"
import { type AgentActor, agentActorSchema } from "@/agents.schema"
import type { SlateId } from "@/database/models/public/Slate"
import { slateSchema } from "@/slates.schema"

const agentInstanceSchema = z.union([
	z.tuple([slateSchema.shape.id, z.string().min(1), z.literal("app"), z.null()]),
	z.tuple([
		slateSchema.shape.id,
		z.string().min(1),
		z.literal("user"),
		z.string().min(1),
	]),
])

export function parseAgentInstanceName(value: string) {
	const [slateId, name, type, id] = agentInstanceSchema.parse(JSON.parse(value))
	return {
		actor: agentActorSchema.parse(type === "app" ? { type } : { id, type }),
		name,
		slateId,
	}
}

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
