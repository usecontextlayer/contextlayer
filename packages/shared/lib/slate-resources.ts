import { z } from "zod"
import { resourcesSchema } from "@/lib/declaration"
import { ownerSchema } from "@/lib/slate-usage"

export const noCommitSchema = z.object({ reason: z.literal("no-commit") })

export const slateResourceConfigurationSchema = resourcesSchema.extend({
	connections: z.record(
		resourcesSchema.shape.connections.keyType,
		resourcesSchema.shape.connections.valueType.extend({
			account_id: z.string().nullable(),
			owner: ownerSchema,
		}),
	),
	databases: z.record(
		resourcesSchema.shape.databases.keyType,
		resourcesSchema.shape.databases.valueType.extend({
			instance_name: z.string().min(1),
			owner: ownerSchema,
		}),
	),
	secrets: z.record(
		resourcesSchema.shape.secrets.keyType,
		z.discriminatedUnion("mode", [
			resourcesSchema.shape.secrets.valueType.extend({
				mode: z.literal("owner"),
				owner: ownerSchema,
			}),
			resourcesSchema.shape.secrets.valueType.extend({
				mode: z.literal("viewer"),
				owner: ownerSchema,
				supplied: z.boolean(),
			}),
		]),
	),
})
export type SlateResourceConfiguration = z.infer<typeof slateResourceConfigurationSchema>

export const slateResourcesSchema = z.object({
	resources: slateResourceConfigurationSchema,
})

export const localResourceConfigurationSchema = resourcesSchema.extend({
	connections: z.record(
		resourcesSchema.shape.connections.keyType,
		resourcesSchema.shape.connections.valueType.extend({
			account_id: z.string().min(1).nullable(),
		}),
	),
	databases: z.record(
		resourcesSchema.shape.databases.keyType,
		resourcesSchema.shape.databases.valueType.extend({
			instance_name: z.string().min(1),
		}),
	),
	secrets: z.record(
		resourcesSchema.shape.secrets.keyType,
		resourcesSchema.shape.secrets.valueType.extend({ value: z.string().nullable() }),
	),
})
export type LocalResourceConfiguration = z.infer<typeof localResourceConfigurationSchema>
