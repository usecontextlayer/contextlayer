import { z } from "@hono/zod-openapi"

export const agentJobRequestSchema = z.object({ prompt: z.string().min(1) })

export const agentJobIdSchema = z.object({ id: z.string() })

export const agentJobSchema = z.object({
	id: z.string(),
	result: z.unknown().optional(),
	status: z.enum(["sending", "queued", "running", "finished", "failed", "interrupted"]),
})
