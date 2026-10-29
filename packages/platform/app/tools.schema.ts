import { z } from "@hono/zod-openapi"
import { personalAccountsQuerySchema } from "@/accounts.schema"
import { assignmentSchema } from "@/slate-connections.schema"
import { slateSchema } from "@/slates.schema"

export {
	accountSessionToolSchema,
	accountSessionToolsSchema,
	accountToolResultSchema,
} from "@usecontextlayer/shared/account-tools"

export {
	connectionRequiredSchema,
	toolResultSchema,
} from "@usecontextlayer/shared/tools"

export const toolExecutionSchema = z.strictObject({
	arguments: z.record(z.string(), z.unknown()),
	tool: z.string().min(1),
})

export const toolCallSchema = toolExecutionSchema.extend({
	slug: assignmentSchema.shape.slug,
})

export const accountToolSessionRequestSchema = z.strictObject({
	slate_id: slateSchema.shape.id,
	toolkit: personalAccountsQuerySchema.shape.toolkit,
})

export const accountToolCallSchema = toolExecutionSchema.extend(
	accountToolSessionRequestSchema.shape,
)

export const accountToolSessionSchema = z.object({ session_id: z.string().min(1) })

export const accountToolParamsSchema = z.object({
	account_id: assignmentSchema.shape.account_id,
})

export const accountToolSessionParamsSchema = accountToolParamsSchema.extend(
	accountToolSessionSchema.shape,
)
