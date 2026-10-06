import { z } from "zod"

export { connectionSchema, connectionsSchema } from "@usecontextlayer/shared/connections"

export const personalConnectionsQuerySchema = z.strictObject({
	toolkit: z.string().min(1),
})

export const authorizeConnectionSchema = z.object({ toolkit: z.string().min(1) })
export const connectionLinkSchema = z.object({ redirect_url: z.url() })
