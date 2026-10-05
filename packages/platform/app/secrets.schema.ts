import { z } from "@hono/zod-openapi"
import { ownerSchema } from "@usecontextlayer/shared/app-usage"

export const secretParamsSchema = z.object({
	name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
	owner_id: z.string().min(1),
	type: z.enum(["org", "user"]),
})

export const setSecretRequestSchema = z.object({ value: z.string().min(1) })

export const secretSchema = z.object({
	name: secretParamsSchema.shape.name,
	owner: ownerSchema,
})

export type SetSecretRequest = z.infer<typeof setSecretRequestSchema>
