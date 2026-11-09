import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryQuery,
	SubmissionId,
	TaskId,
	UserInput,
} from "@earendil-works/pi-durable"
import { z } from "@hono/zod-openapi"
import { secretNameSchema } from "@usecontextlayer/shared/declaration"
import { agentActorSchema } from "@usecontextlayer/shared/slate-provisioning"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import type { Schedule } from "agents/schedules"

import { slateSchema, slateTargetSchema } from "@/slates.schema"

export type { AgentActor } from "@usecontextlayer/shared/slate-provisioning"
export { agentActorSchema } from "@usecontextlayer/shared/slate-provisioning"

export const agentSchema = z.object({
	commit: z.string(),
	instructions: z.string(),
})

export const agentParamsSchema = z.object({
	name: z.string().min(1).openapi({
		description: "Agent directory name under agents/ in the pushed source.",
	}),
	target: slateTargetSchema,
})

export const agentInstanceParamsSchema = agentParamsSchema.extend({
	actor: z.enum(["user", "app"]).openapi({
		description:
			"Required instance address: user selects the authenticated caller's SlateAgent; app selects this named agent's app SlateAgent. Native IDs and cursors belong to that instance.",
	}),
})

export const agentCreateConversationParamsSchema = agentInstanceParamsSchema.extend({
	actor: z.literal("user").openapi({
		description:
			"Manual input is supported only in the authenticated caller's SlateAgent.",
	}),
})

const piIdSchema = z.coerce.number().int().positive()
export const agentConversationIdSchema = piIdSchema.transform(
	(id) => id as ConversationId,
)
export const agentSubmissionIdSchema = piIdSchema.transform((id) => id as SubmissionId)
const piEntryIdSchema = piIdSchema.transform((id) => id as EntryId)
const piTaskIdSchema = piIdSchema.transform((id) => id as TaskId)

export const agentConversationParamsSchema = agentInstanceParamsSchema.extend({
	conversationId: agentConversationIdSchema,
})
export const agentSubmissionParamsSchema = agentInstanceParamsSchema.extend({
	submissionId: agentSubmissionIdSchema,
})
export const agentSubmitInputParamsSchema = agentCreateConversationParamsSchema.extend({
	conversationId: agentConversationIdSchema,
})

const piUserInputSchema = z.union([
	z.string(),
	z.array(
		z.discriminatedUnion("type", [
			z.object({
				text: z.string(),
				textSignature: z.string().optional(),
				type: z.literal("text"),
			}),
			z.object({
				data: z.string(),
				mimeType: z.string(),
				type: z.literal("image"),
			}),
		]),
	),
]) satisfies z.ZodType<UserInput>

export const agentSubmissionRequestSchema = z.strictObject({
	content: piUserInputSchema,
	requestId: z.string().optional().openapi({
		description: "Native Pi deduplication key, scoped to this conversation.",
	}),
})

export const agentCursorSchema = z.record(z.string(), z.json()).openapi({
	additionalProperties: true,
	description: "Opaque native Pi scan cursor. Return it unchanged to the same scan.",
	type: "object",
}) satisfies z.ZodType<Cursor>

const piCursorQuerySchema = z
	.string()
	.transform((value, ctx) => {
		try {
			return JSON.parse(value) as unknown
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error
			ctx.addIssue({ code: "custom", message: "Use a JSON-encoded native Pi cursor" })
			return z.NEVER
		}
	})
	.pipe(agentCursorSchema)
	.openapi({
		description:
			"JSON-encode the previous page's native next cursor without changing it.",
		type: "string",
	})

const piPageQuerySchema = z.object({
	cursor: piCursorQuerySchema.optional(),
	limit: z.coerce.number().int().positive(),
})
const piScanOrderSchema = z.enum(["ascending", "descending"])

export const agentConversationQuerySchema = z.object({
	order: piScanOrderSchema.optional(),
	ownerConversationId: agentConversationIdSchema.optional(),
	ownerTaskId: piTaskIdSchema.optional(),
}) satisfies z.ZodType<ConversationQuery>

export const agentEntriesQuerySchema = z.object({
	maxEntryId: piEntryIdSchema.optional(),
	minEntryId: piEntryIdSchema.optional(),
	order: piScanOrderSchema.optional(),
}) satisfies z.ZodType<Omit<EntryQuery, "conversationId">>

export const agentConversationsPageQuerySchema = agentConversationQuerySchema.extend(
	piPageQuerySchema.shape,
)
export const agentEntriesPageQuerySchema = agentEntriesQuerySchema.extend(
	piPageQuerySchema.shape,
)

export const agentConversationSchema = z.looseObject({
	id: agentConversationIdSchema,
	owner: z
		.looseObject({ conversationId: agentConversationIdSchema, taskId: piTaskIdSchema })
		.optional(),
	parent: z
		.looseObject({ at: piEntryIdSchema, conversationId: agentConversationIdSchema })
		.optional(),
}) satisfies z.ZodType<ConversationRecord>

const piSubmissionSchema = z.looseObject({
	conversationId: agentConversationIdSchema,
	id: agentSubmissionIdSchema,
	requestId: z.string().optional(),
	trace: z.record(z.string(), z.string()).optional(),
})
const piInputSubmissionSchema = piSubmissionSchema.extend({ type: z.literal("input") })
const piWriteSubmissionSchema = piSubmissionSchema.extend({ type: z.literal("write") })
const piContinueSubmissionSchema = piSubmissionSchema.extend({
	type: z.literal("continue"),
})
const piUnansweredSubmissionShape = {
	// Keep JSON validation, but expose opaque HTTP typing: recursive JSON exceeds Hono's compiler limit.
	// https://github.com/honojs/hono/issues/5543
	detail: z
		.json()
		.transform((detail): unknown => detail)
		.optional()
		.openapi({
			additionalProperties: true,
			description: "Opaque native JSON detail for an unanswered submission.",
			items: {},
			type: ["string", "number", "boolean", "null", "object", "array"],
		}),
	reason: z.string(),
	status: z.literal("unanswered"),
}

export const agentSubmissionSchema = z.union([
	piInputSubmissionSchema.extend({ status: z.literal("queued") }),
	piInputSubmissionSchema.extend({ entry: piEntryIdSchema, status: z.literal("placed") }),
	piInputSubmissionSchema.extend({
		answer: piEntryIdSchema,
		entry: piEntryIdSchema,
		status: z.literal("done"),
	}),
	piInputSubmissionSchema.extend({
		...piUnansweredSubmissionShape,
		entry: piEntryIdSchema.optional(),
	}),
	piWriteSubmissionSchema.extend({ status: z.literal("queued") }),
	piWriteSubmissionSchema.extend({ entry: piEntryIdSchema, status: z.literal("done") }),
	piWriteSubmissionSchema.extend(piUnansweredSubmissionShape),
	piContinueSubmissionSchema.extend({ status: z.literal("placed") }),
	piContinueSubmissionSchema.extend({
		answer: piEntryIdSchema,
		status: z.literal("done"),
	}),
	piContinueSubmissionSchema.extend(piUnansweredSubmissionShape),
])

export const agentConversationsPageSchema = z.object({
	items: z.array(agentConversationSchema),
	next: agentCursorSchema.optional(),
})
export const agentScheduleParamsSchema = agentInstanceParamsSchema.extend({
	scheduleId: z.string().min(1).openapi({
		description: "Native provisioned schedule ID from the schedule listing.",
	}),
})
const piMessageSchema = z
	.looseObject({
		role: z.enum(["system", "user", "assistant", "toolResult"]),
		timestamp: z.number(),
	})
	.openapi({
		description:
			"Native Pi model message. Content, usage, tools, and provider fields pass through unchanged.",
	})
export const agentEntrySchema = z
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
			"Native Pi EntryRecord. Model messages and extension payloads pass through unchanged.",
	})

export const agentEntriesPageSchema = z.object({
	items: z.array(agentEntrySchema),
	next: agentCursorSchema.optional(),
})
export const agentConversationViewSchema = z
	.looseObject({
		before: piEntryIdSchema.optional(),
		conversation: agentConversationSchema,
		docs: z.record(z.string(), z.looseObject({})).openapi({
			description:
				"Native built-in conversation documents, including internal execution and rendered system sections. Requires inspection authorization.",
		}),
		entries: z.array(agentEntrySchema),
	})
	.openapi({
		description:
			"Native Pi ConversationView with recent entries and current conversation documents.",
	})

export const agentScheduleSchema = z.object({
	cron: z.string().trim(),
	name: z.string().min(1),
	prompt: z.string().min(1).openapi({
		description:
			"User message submitted in a fresh conversation for each schedule firing.",
	}),
})

export const scheduledAgentRunSchema = z.strictObject({
	actor: agentActorSchema,
	name: agentParamsSchema.shape.name,
	prompt: agentScheduleSchema.shape.prompt,
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

export const agentConfigurationSchema = z.strictObject({
	actor: agentActorSchema,
	agent: agentSchema.extend({ name: agentParamsSchema.shape.name }),
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
	secrets: z.record(secretNameSchema, ownerSchema),
	slateId: slateSchema.shape.id,
})

export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>
export type AgentSubmissionRequest = z.infer<typeof agentSubmissionRequestSchema>
export type AgentConversationsPageQuery = z.infer<
	typeof agentConversationsPageQuerySchema
>
export type AgentEntriesPageQuery = z.infer<typeof agentEntriesPageQuerySchema>
export type AgentSchedule = z.infer<typeof agentScheduleSchema>
export type ScheduledAgentRun = z.infer<typeof scheduledAgentRunSchema>
