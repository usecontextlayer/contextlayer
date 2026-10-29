import { z } from "@hono/zod-openapi"
import { secretNameSchema } from "@/lib/declaration"
import { agentActorSchema } from "@/lib/slate-provisioning"

export type { AgentActor } from "@/lib/slate-provisioning"
export { agentActorSchema } from "@/lib/slate-provisioning"

export const agentSchema = z.object({
	commit: z.string(),
	instructions: z.string(),
})

export const agentRunRequestSchema = z.strictObject({
	name: z.string().min(1).openapi({
		description: "Agent directory name under agents/ in the selected source.",
	}),
	prompt: z.string().min(1).openapi({
		description: "User message for a fresh job, separate from its standing instructions.",
	}),
})

export const agentJobTriggerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("api") }),
	z.object({ schedule: z.string(), scheduleId: z.string(), type: z.literal("schedule") }),
])
export const agentJobMetadataSchema = z.object({
	actor: agentActorSchema,
	trigger: agentJobTriggerSchema,
})
export type AgentJobMetadata = z.infer<typeof agentJobMetadataSchema>
export type AgentJobTrigger = z.infer<typeof agentJobTriggerSchema>

export const agentScheduleSchema = z.object({
	cron: z
		.string()
		.trim()
		.refine((cron) => cron.split(/\s+/).length === 5, {
			message: "Use a five-field cron expression in UTC",
		}),
	name: z.string().min(1),
	prompt: agentRunRequestSchema.shape.prompt,
})

export const scheduledAgentRunSchema = agentRunRequestSchema.extend({
	actor: agentActorSchema,
	schedule: agentScheduleSchema.shape.name,
	slateId: z.string().min(1),
})

export const agentRunSchema = z.strictObject({
	actor: agentActorSchema,
	agent: agentSchema.extend({ name: agentRunRequestSchema.shape.name }),
	connections: z.record(
		z.string(),
		z.object({ toolkit: z.string().min(1) }).catchall(z.json()),
	),
	databases: z.record(z.string(), z.json()),
	prompt: agentRunRequestSchema.shape.prompt,
	secrets: z.record(secretNameSchema, z.json()),
	slateId: z.string().min(1),
})

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>
export type AgentRun = z.infer<typeof agentRunSchema>
export type AgentSchedule = z.infer<typeof agentScheduleSchema>
export type ScheduledAgentRun = z.infer<typeof scheduledAgentRunSchema>
