import { z } from "zod"
import { appResourceConfigurationSchema } from "@/lib/app-resources"

export const appConnectionSchema =
	appResourceConfigurationSchema.shape.connections.valueType.extend({
		slug: z.string(),
	})
export type AppConnection = z.infer<typeof appConnectionSchema>

export const appConnectionsSchema = z.object({
	connections: z.array(appConnectionSchema),
})
