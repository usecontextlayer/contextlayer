import { z } from "zod"
import { databaseMigrationsSchema } from "@/lib/databases"
import { resourcesSchema } from "@/lib/declaration"
import { ownerSchema } from "@/lib/slate-usage"

export const noCommitSchema = z.object({ reason: z.literal("no-commit") })

export const slateResourceConfigurationSchema = resourcesSchema.extend({
	connections: z.record(
		resourcesSchema.shape.connections.keyType,
		resourcesSchema.shape.connections.valueType.extend({
			connection_id: z.string().nullable(),
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
		resourcesSchema.shape.secrets.valueType.extend({ owner: ownerSchema }),
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
			connection_id: z.string().min(1).nullable(),
		}),
	),
	databases: z.record(
		resourcesSchema.shape.databases.keyType,
		resourcesSchema.shape.databases.valueType.extend({
			instance_name: z.string().min(1),
			migrations: databaseMigrationsSchema,
		}),
	),
	secrets: z.record(
		resourcesSchema.shape.secrets.keyType,
		resourcesSchema.shape.secrets.valueType.extend({ value: z.string().nullable() }),
	),
})
export type LocalResourceConfiguration = z.infer<typeof localResourceConfigurationSchema>
