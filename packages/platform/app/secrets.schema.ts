import { z } from "@hono/zod-openapi"
import { secretNameSchema } from "@usecontextlayer/shared/declaration"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import { ownerParamsSchema } from "@/owner.schema"

export const secretParamsSchema = ownerParamsSchema.extend({
	name: secretNameSchema,
})

export const setSecretRequestSchema = z.object({ value: z.string().min(1) })

export const secretSchema = z.object({
	name: secretParamsSchema.shape.name,
	owner: ownerSchema,
})

export type SetSecretRequest = z.infer<typeof setSecretRequestSchema>
