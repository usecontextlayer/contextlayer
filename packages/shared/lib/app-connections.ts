import { z } from "zod"
import { connectionRequirementSchema } from "@/lib/slate"

export const appConnectionSchema = connectionRequirementSchema.extend({
	connection_id: z.string().nullable(),
	slug: z.string(),
})
export type AppConnection = z.infer<typeof appConnectionSchema>

export const appConnectionsSchema = z.object({
	connections: z.array(appConnectionSchema),
})
