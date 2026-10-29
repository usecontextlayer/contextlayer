import { z } from "@hono/zod-openapi"
import {
	agentRunSchema as portableAgentRunSchema,
	agentRuntimeScheduleSchema as portableAgentRuntimeScheduleSchema,
	scheduledAgentRunSchema as portableScheduledAgentRunSchema,
} from "@usecontextlayer/shared/agents"
import { secretNameSchema } from "@usecontextlayer/shared/declaration"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import { slateSchema } from "@/slates.schema"

export * from "@usecontextlayer/shared/agents"

export {
	agentJobParamsSchema,
	agentJobSessionParamsSchema,
	agentParamsSchema,
	agentScheduleParamsSchema,
} from "@usecontextlayer/shared/agents-api"

export const scheduledAgentRunSchema = portableScheduledAgentRunSchema.extend({
	slateId: slateSchema.shape.id,
})
export const agentRuntimeScheduleSchema = portableAgentRuntimeScheduleSchema.extend({
	payload: scheduledAgentRunSchema,
})
export const agentRunSchema = portableAgentRunSchema.extend({
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
export type AgentRun = z.infer<typeof agentRunSchema>
export type ScheduledAgentRun = z.infer<typeof scheduledAgentRunSchema>
