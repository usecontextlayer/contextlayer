import { z } from "@hono/zod-openapi"
import { assignmentSchema } from "@/app-connections.schema"

export const toolCallSchema = z.object({
	arguments: z.record(z.string(), z.unknown()),
	slug: assignmentSchema.shape.slug,
	tool: z.string().min(1),
})

export const toolResultSchema = z.object({
	data: z.record(z.string(), z.unknown()),
	error: z.string().nullable(),
	logId: z.string(),
})
