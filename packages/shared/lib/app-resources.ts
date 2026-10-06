import { z } from "zod"
import { ownerSchema } from "@/lib/app-usage"
import { resourcesSchema } from "@/lib/slate"

export const appResourceConfigurationSchema = resourcesSchema.extend({
	connections: z.record(
		resourcesSchema.shape.connections.keyType,
		resourcesSchema.shape.connections.valueType.extend({
			connection_id: z.string().nullable(),
			owner: ownerSchema,
		}),
	),
	folders: z.record(
		resourcesSchema.shape.folders.keyType,
		resourcesSchema.shape.folders.valueType.extend({ owner: ownerSchema }),
	),
	secrets: z.record(
		resourcesSchema.shape.secrets.keyType,
		resourcesSchema.shape.secrets.valueType.extend({ owner: ownerSchema }),
	),
})
export type AppResourceConfiguration = z.infer<typeof appResourceConfigurationSchema>

export const appResourcesSchema = z.object({ resources: appResourceConfigurationSchema })

export const localResourceConfigurationSchema = resourcesSchema.extend({
	connections: z.record(
		resourcesSchema.shape.connections.keyType,
		resourcesSchema.shape.connections.valueType.extend({
			connection_id: z.string().min(1).nullable(),
		}),
	),
	folders: z.record(
		resourcesSchema.shape.folders.keyType.regex(/^(?!\.{1,2}$)[^/\\]+$/),
		resourcesSchema.shape.folders.valueType.extend({ path: z.string().min(1) }),
	),
	secrets: z.record(
		resourcesSchema.shape.secrets.keyType,
		resourcesSchema.shape.secrets.valueType.extend({ value: z.string().nullable() }),
	),
})
export type LocalResourceConfiguration = z.infer<typeof localResourceConfigurationSchema>
