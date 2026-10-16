import { z } from "@hono/zod-openapi"
import { secretNameSchema } from "@usecontextlayer/shared/declaration"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import type { Schedule } from "agents"
import type { PiOperationResult, PiPendingOperation, PiReceipt } from "agents/harness/pi"
import type { RoutedAgentEntry } from "agents/routing"
import { userSchema } from "@/auth.server"
import { slateSchema, slateTargetSchema } from "@/slates.schema"

export const agentSchema = z.object({
	commit: z.string(),
	instructions: z.string(),
})

export const agentRunRequestSchema = z.strictObject({
	name: z.string().min(1),
	prompt: z.string().min(1),
})

export const agentParamsSchema = z.object({
	name: agentRunRequestSchema.shape.name,
	target: slateTargetSchema,
})
export const agentJobRequestSchema = agentRunRequestSchema.omit({ name: true })
export const agentJobReceiptSchema = z.object({
	accepted: z.boolean(),
	operationId: z.uuid(),
	session: z.string(),
}) satisfies z.ZodType<PiReceipt>
export const agentJobPendingSchema = z.object({
	operationId: z.uuid(),
	session: z.string(),
	status: z.enum(["queued", "running"]),
}) satisfies z.ZodType<PiPendingOperation>
export const agentJobResultSchema = z.object({
	operationId: z.uuid(),
	reason: z.string().optional(),
	session: z.string(),
	status: z.enum(["done", "unanswered"]),
	text: z.string().optional(),
}) satisfies z.ZodType<PiOperationResult>
export const agentJobOperationSchema = z.union([
	agentJobPendingSchema,
	agentJobResultSchema,
])
export const agentActorSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("app") }),
	z.object({ id: userSchema.shape.id, type: z.literal("user") }),
])

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

export const agentJobEntrySchema = z.object({
	createdAt: z.number(),
	id: z.uuid(),
	metadata: agentJobMetadataSchema.nullable(),
	updatedAt: z.number(),
}) satisfies z.ZodType<RoutedAgentEntry<AgentJobMetadata>>
export const agentJobCreationSchema = z.object({
	job: agentJobEntrySchema,
	receipt: agentJobReceiptSchema,
})
export const agentJobsQuerySchema = z.object({ schedule: z.string().min(1).optional() })
export const agentScheduleParamsSchema = agentParamsSchema.extend({
	scheduleId: z.string().min(1),
})
export const agentJobParamsSchema = agentParamsSchema.extend({
	id: agentJobEntrySchema.shape.id,
})

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
	slateId: slateSchema.shape.id,
})

export const agentRuntimeScheduleSchema = z.object({
	callback: z.string(),
	cron: z.string(),
	id: z.string(),
	payload: scheduledAgentRunSchema,
	retry: z
		.object({
			baseDelayMs: z.number().optional(),
			maxAttempts: z.number().optional(),
			maxDelayMs: z.number().optional(),
		})
		.optional(),
	time: z.number(),
	type: z.literal("cron"),
}) satisfies z.ZodType<
	Extract<Schedule<z.infer<typeof scheduledAgentRunSchema>>, { type: "cron" }>
>

export const agentRunSchema = z.strictObject({
	actor: agentActorSchema,
	agent: agentSchema.extend({ name: agentRunRequestSchema.shape.name }),
	connections: z.record(
		z.string(),
		z.object({
			connection_id: z.string(),
			owner: ownerSchema,
			toolkit: z.string().min(1),
		}),
	),
	databases: z.record(
		slateResourceConfigurationSchema.shape.databases.keyType,
		slateResourceConfigurationSchema.shape.databases.valueType.pick({
			instance_name: true,
			owner: true,
		}),
	),
	prompt: agentRunRequestSchema.shape.prompt,
	secrets: z.record(secretNameSchema, ownerSchema),
	slateId: slateSchema.shape.id,
})

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>
export type AgentRun = z.infer<typeof agentRunSchema>
export type AgentJobOperation = z.infer<typeof agentJobOperationSchema>
export type AgentJobEntry = z.infer<typeof agentJobEntrySchema>
export type AgentActor = z.infer<typeof agentActorSchema>
export type AgentSchedule = z.infer<typeof agentScheduleSchema>
export type ScheduledAgentRun = z.infer<typeof scheduledAgentRunSchema>
