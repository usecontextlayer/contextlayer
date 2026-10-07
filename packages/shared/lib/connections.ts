import { z } from "zod"

export const connectionSchema = z.object({
	alias: z.string().nullable(),
	display_name: z.string().nullable(),
	id: z.string(),
	status: z.literal("ACTIVE"),
	toolkit: z.string(),
})

export const connectionsSchema = z.object({ connections: z.array(connectionSchema) })
