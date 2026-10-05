import { z } from "@hono/zod-openapi"
import { ownerSchema } from "@usecontextlayer/shared/app-usage"
import { secretNameSchema } from "@usecontextlayer/shared/slate"
import { appSchema } from "@/apps.schema"
import { userSchema } from "@/auth.server"

export const agentSchema = z.object({
	commit: z.string(),
	instructions: z.string(),
})

export const agentRunRequestSchema = z.strictObject({
	name: z.string().min(1),
	prompt: z.string().min(1),
})

export const agentRunSchema = z.strictObject({
	agent: agentSchema.extend({ name: agentRunRequestSchema.shape.name }),
	appId: appSchema.shape.id,
	prompt: agentRunRequestSchema.shape.prompt,
	secrets: z.record(secretNameSchema, ownerSchema),
	viewerId: userSchema.shape.id,
})

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>
export type AgentRun = z.infer<typeof agentRunSchema>
