import { z } from "@hono/zod-openapi"

export const agentSchema = z.object({
	commit: z.string(),
	instructions: z.string(),
})
