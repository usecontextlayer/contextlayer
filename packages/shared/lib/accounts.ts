import { z } from "zod"

export const accountSchema = z.object({
	alias: z.string().nullable(),
	display_name: z.string().nullable(),
	id: z.string(),
	status: z.literal("ACTIVE"),
	toolkit: z.string(),
})

export const accountsSchema = z.object({ accounts: z.array(accountSchema) })
