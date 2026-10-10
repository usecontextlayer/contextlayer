import { z } from "zod"
import { slateResourceConfigurationSchema } from "@/lib/slate-resources"

export const slateConnectionSchema =
	slateResourceConfigurationSchema.shape.connections.valueType.extend({
		slug: z.string(),
	})
export type SlateConnection = z.infer<typeof slateConnectionSchema>

export const slateConnectionsSchema = z.object({
	connections: z.array(slateConnectionSchema),
})
