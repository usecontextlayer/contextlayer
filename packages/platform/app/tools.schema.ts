import { z } from "@hono/zod-openapi"
import { personalConnectionsQuerySchema } from "@/connections.schema"
import { assignmentSchema } from "@/slate-connections.schema"
import { slateSchema } from "@/slates.schema"

export { connectionRequiredSchema, toolResultSchema } from "@usecontextlayer/shared/tools"

export const toolExecutionSchema = z.strictObject({
	arguments: z.record(z.string(), z.unknown()),
	tool: z.string().min(1),
})

export const toolCallSchema = toolExecutionSchema.extend({
	slug: assignmentSchema.shape.slug,
})

export const connectionToolCallSchema = toolExecutionSchema.extend({
	slate_id: slateSchema.shape.id,
	toolkit: personalConnectionsQuerySchema.shape.toolkit,
})

export const connectionToolParamsSchema = z.object({
	connection_id: assignmentSchema.shape.connection_id,
})
