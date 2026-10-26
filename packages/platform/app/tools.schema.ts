import { z } from "@hono/zod-openapi"
import { personalAccountsQuerySchema } from "@/accounts.schema"
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

export const accountToolCallSchema = toolExecutionSchema.extend({
	slate_id: slateSchema.shape.id,
	toolkit: personalAccountsQuerySchema.shape.toolkit,
})

export const accountToolParamsSchema = z.object({
	account_id: assignmentSchema.shape.account_id,
})
