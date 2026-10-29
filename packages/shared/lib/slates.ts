import { z } from "@hono/zod-openapi"

export const slateTargetSchema = z.union([
	z.uuid().transform((id) => ({ id })),
	z
		.hostname()
		.toLowerCase()
		.transform((public_hostname) => ({ public_hostname })),
])
export type SlateTarget = z.infer<typeof slateTargetSchema>
