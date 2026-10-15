import { z } from "@hono/zod-openapi"
import { secretNameSchema } from "@usecontextlayer/shared/declaration"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
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
export const agentJobSummarySchema = z.object({
	completed_at: z
		.number()
		.describe("Think completion time, in Unix milliseconds")
		.optional(),
	created_at: z.number().describe("Think submission creation time, in Unix milliseconds"),
	error: z.string().optional(),
	id: z.uuid(),
	instance_name: z.string().min(1),
	source: z.enum(["api", "schedule"]),
	started_at: z
		.number()
		.describe("Think turn start time, in Unix milliseconds")
		.optional(),
	status: z.enum(["pending", "running", "completed", "aborted", "skipped", "error"]),
})
export const agentJobSchema = agentJobSummarySchema.extend({
	message: z
		.object({
			id: z.string(),
			metadata: z.unknown().optional(),
			parts: z
				.array(z.looseObject({ type: z.string() }))
				.describe("AI SDK message parts in their original order"),
			role: z.string(),
		})
		.nullable()
		.describe(
			"Assistant message as saved by Think. Null until Think persists a message.",
		),
})
export const agentJobParamsSchema = agentParamsSchema.extend({
	id: agentJobSchema.shape.id,
})

export const agentJobQuerySchema = z.object({
	instance_name: agentJobSchema.shape.instance_name,
})

export const agentActorSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("app") }),
	z.object({ id: userSchema.shape.id, type: z.literal("user") }),
])

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
export type AgentJob = z.infer<typeof agentJobSchema>
export type AgentJobSummary = z.infer<typeof agentJobSummarySchema>
export type AgentActor = z.infer<typeof agentActorSchema>
export type AgentSchedule = z.infer<typeof agentScheduleSchema>
export type ScheduledAgentRun = z.infer<typeof scheduledAgentRunSchema>
