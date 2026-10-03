import { z } from "zod"

export const connectionSchema = z.object({
	alias: z.string().nullable(),
	display_name: z.string().nullable(),
	id: z.string(),
	status: z.string(),
	toolkit: z.string(),
})

export const connectionsSchema = z.object({ connections: z.array(connectionSchema) })

export const authorizeConnectionSchema = z.object({ toolkit: z.string().min(1) })
export const connectionLinkSchema = z.object({ redirect_url: z.url() })
