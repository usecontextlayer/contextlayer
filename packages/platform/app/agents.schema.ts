import type { Usage } from "@earendil-works/pi-ai"
import type { UsageState } from "@earendil-works/pi-durable"
import { z } from "@hono/zod-openapi"
import { secretNameSchema } from "@usecontextlayer/shared/declaration"
import { agentActorSchema } from "@usecontextlayer/shared/slate-provisioning"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import type { Schedule } from "agents"
import type {
	PiOperationResult,
	PiPendingOperation,
	PiReceipt,
	PiSessionInfo,
} from "agents/harness/pi"
import type { RoutedAgentEntry } from "agents/routing"

import { slateSchema, slateTargetSchema } from "@/slates.schema"

export type { AgentActor } from "@usecontextlayer/shared/slate-provisioning"
export { agentActorSchema } from "@usecontextlayer/shared/slate-provisioning"

export const agentSchema = z.object({
	commit: z.string(),
	instructions: z.string(),
})

export const agentRunRequestSchema = z.strictObject({
	name: z.string().min(1).openapi({
		description: "Agent directory name under agents/ in the pushed source.",
	}),
	prompt: z.string().min(1).openapi({
		description: "User message for a fresh job, separate from its standing instructions.",
	}),
})

export const agentParamsSchema = z.object({
	name: agentRunRequestSchema.shape.name,
	target: slateTargetSchema,
})
export const agentJobRequestSchema = agentRunRequestSchema.omit({ name: true })
export const agentJobReceiptSchema = z.object({
	accepted: z.boolean().openapi({
		description: "Whether the native operation was admitted; not a task-success result.",
	}),
	operationId: z.string().openapi({
		description: "Native Pi operation identifier, distinct from the catalog job ID.",
	}),
	session: z.string().openapi({
		description: "Pi session ID scoped to this job; IDs can recur in other jobs.",
	}),
}) satisfies z.ZodType<PiReceipt>
export const agentJobPendingSchema = z.object({
	operationId: agentJobReceiptSchema.shape.operationId,
	session: agentJobReceiptSchema.shape.session,
	status: z.enum(["queued", "running"]),
}) satisfies z.ZodType<PiPendingOperation>
export const agentJobResultSchema = z.object({
	operationId: agentJobReceiptSchema.shape.operationId,
	reason: z.string().optional().openapi({
		description: "Native explanation when the operation settles without an answer.",
	}),
	session: agentJobReceiptSchema.shape.session,
	status: z.enum(["done", "unanswered"]).openapi({
		description:
			"done means the operation answered; unanswered means it settled without an answer. Neither asserts task success.",
	}),
	text: z.string().optional().openapi({
		description:
			"Final answer text when supplied by the native operation; not a transcript.",
	}),
}) satisfies z.ZodType<PiOperationResult>
export const agentJobOperationSchema = z.union([
	agentJobPendingSchema,
	agentJobResultSchema,
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
	createdAt: z
		.number()
		.openapi({ description: "Catalog creation time in Unix milliseconds." }),
	id: z.uuid().openapi({
		description: "Catalog job ID used by job routes.",
	}),
	metadata: agentJobMetadataSchema.nullable(),
	updatedAt: z.number().openapi({
		description: "Last catalog update in Unix milliseconds; not execution progress.",
	}),
}) satisfies z.ZodType<RoutedAgentEntry<AgentJobMetadata>>
export const agentJobCreationSchema = z.object({
	job: agentJobEntrySchema,
	receipt: agentJobReceiptSchema,
})
export const agentJobsQuerySchema = z.object({
	schedule: z.string().min(1).optional().openapi({
		description: "Authored schedule name, independent of the native schedule ID.",
	}),
})
export const agentScheduleParamsSchema = agentParamsSchema.extend({
	scheduleId: z.string().min(1).openapi({
		description: "Native provisioned schedule ID from the schedule listing.",
	}),
})
export const agentJobParamsSchema = agentParamsSchema.extend({
	id: agentJobEntrySchema.shape.id,
})

export const agentJobSessionParamsSchema = agentJobParamsSchema.extend({
	session: z
		.string()
		.refine((session) => Number.isSafeInteger(Number(session)) && Number(session) >= 1, {
			message: "Use a positive integer Pi session ID",
		}),
})
export const agentJobSessionSchema = z.object({
	busy: z.boolean(),
	id: agentJobReceiptSchema.shape.session,
	parent: z.string().optional().openapi({
		description: "Parent session ID within the same job, when present.",
	}),
}) satisfies z.ZodType<PiSessionInfo>

const piMessageSchema = z
	.looseObject({
		role: z.enum(["system", "user", "assistant", "toolResult"]),
		timestamp: z.number(),
	})
	.openapi({
		description:
			"Native Pi model message. Content, usage, tools, and provider fields pass through unchanged.",
	})
export const agentJobMessageSchema = z
	.looseObject({
		byTaskId: z.number().optional(),
		conversationId: z.number(),
		data: z.unknown().optional().openapi({
			description: "Opaque native entry payload, including extension-defined JSON.",
		}),
		edits: z
			.array(
				z.looseObject({
					action: z.enum(["omit", "replace"]),
					messages: z.array(piMessageSchema).optional(),
					target: z.number(),
				}),
			)
			.optional(),
		head: z.number().optional(),
		id: z.number(),
		kind: z.string(),
		model: z.array(piMessageSchema).optional(),
	})
	.openapi({
		description:
			"Native active EntryRecord; native payload fields are preserved, not normalized into chat messages.",
	})

const piUsageSchema = z.looseObject({
	cacheRead: z.number(),
	cacheWrite: z.number(),
	cacheWrite1h: z.number().optional(),
	cost: z.looseObject({
		cacheRead: z.number(),
		cacheWrite: z.number(),
		input: z.number(),
		output: z.number(),
		total: z.number(),
	}),
	input: z.number(),
	output: z.number(),
	reasoning: z.number().optional(),
	totalTokens: z.number(),
}) satisfies z.ZodType<Usage>
export const agentJobUsageSchema = z
	.looseObject({
		models: z.record(z.string(), piUsageSchema),
		tools: z.record(z.string(), piUsageSchema),
	})
	.openapi({
		description:
			"Native model and tool usage aggregated across this job's conversations.",
	}) satisfies z.ZodType<UsageState>

export const agentJobInspectionSchema = z
	.looseObject({
		scheduling: z.enum(["paused", "running", "closing"]),
		submissions: z.array(
			z.looseObject({}).openapi({
				description: "Opaque native SubmissionRecord, passed through unchanged.",
			}),
		),
		tasks: z.array(
			z.looseObject({}).openapi({
				description: "Opaque native TaskInspection, passed through unchanged.",
			}),
		),
	})
	.openapi({
		description:
			"Native HarnessInspection of live work: unfinished tasks and queued or placed submissions. May be empty after settlement; use messages for completed work.",
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
	time: z.number().openapi({ description: "Unix seconds." }),
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
			account_id: z.string(),
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
export type AgentSchedule = z.infer<typeof agentScheduleSchema>
export type ScheduledAgentRun = z.infer<typeof scheduledAgentRunSchema>
