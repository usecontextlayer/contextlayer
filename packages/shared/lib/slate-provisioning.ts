import { z } from "zod"
import type { Resources, SlateDeclarations } from "@/lib/declaration"
import type { Owner, ResolvedSlate } from "@/lib/slate-usage"

export const agentActorSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("app") }),
	z.object({ id: z.string().min(1), type: z.literal("user") }),
])
export type AgentActor = z.infer<typeof agentActorSchema>

export type SlateDeclarationSnapshot = {
	allowed: true
	commit: string
	agentTrees: { name: string; hash: string }[]
	declarations: SlateDeclarations
	resources: Resources
}

export type SlateProvisioning = {
	slate: ResolvedSlate
	snapshot: SlateDeclarationSnapshot
	actors: AgentActor[]
	databases: { slug: string; instance_name: string; owner: Owner }[]
}
