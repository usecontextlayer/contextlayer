import { z } from "@hono/zod-openapi"
import { slateSchema } from "@/app-connections.schema"

export const agentSchema = z.object({
	commit: z.string(),
	files: z.array(z.string()),
	manifest: slateSchema,
})
