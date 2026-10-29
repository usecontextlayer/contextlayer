import { z } from "zod"

export const credentialModeSchema = z.enum(["viewer", "owner"])
export type CredentialMode = z.infer<typeof credentialModeSchema>

export const connectionRequirementSchema = z.strictObject({
	mode: credentialModeSchema,
	toolkit: z.string().min(1),
})
export const secretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
export const secretRequirementSchema = z.strictObject({ mode: credentialModeSchema })
export const databaseRequirementSchema = z.strictObject({ mode: credentialModeSchema })
export const databaseSlugSchema = z
	.string()
	.min(1)
	.regex(/^(?!\.{1,2}$)[^/\\]+$/)

export const declarationSchema = z.strictObject({
	connections: z.record(z.string().min(1), connectionRequirementSchema),
	databases: z.record(databaseSlugSchema, databaseRequirementSchema).default({}),
	secrets: z.record(secretNameSchema, secretRequirementSchema).default({}),
})
export type Declaration = z.infer<typeof declarationSchema>

export const slateDeclarationsSchema = z.strictObject({
	agents: z.record(z.string().min(1), declarationSchema),
	app: declarationSchema.optional(),
})
export type SlateDeclarations = z.infer<typeof slateDeclarationsSchema>

export const resourceConsumerSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("app") }),
	z.strictObject({ name: z.string().min(1), type: z.literal("agent") }),
])
export type ResourceConsumer = z.infer<typeof resourceConsumerSchema>

export const resourcesSchema = declarationSchema.extend({
	connections: z.record(
		z.string().min(1),
		connectionRequirementSchema.extend({ consumers: z.array(resourceConsumerSchema) }),
	),
	databases: z.record(
		databaseSlugSchema,
		databaseRequirementSchema.extend({ consumers: z.array(resourceConsumerSchema) }),
	),
	secrets: z.record(
		secretNameSchema,
		secretRequirementSchema.extend({ consumers: z.array(resourceConsumerSchema) }),
	),
})
export type Resources = z.infer<typeof resourcesSchema>

export function hasViewerResources(resources: Resources) {
	return Object.values(resources).some((requirements) =>
		Object.values(requirements).some(({ mode }) => mode === "viewer"),
	)
}

export function collectSlateResources(slateDeclarations: SlateDeclarations): Resources {
	const declarations: { consumer: ResourceConsumer; declaration: Declaration }[] =
		Object.entries(slateDeclarations.agents).map(([name, declaration]) => ({
			consumer: { name, type: "agent" },
			declaration,
		}))
	if (slateDeclarations.app) {
		declarations.unshift({
			consumer: { type: "app" },
			declaration: slateDeclarations.app,
		})
	}
	return {
		connections: collectRequirements(
			"connections",
			declarations,
			(declaration) => declaration.connections,
		),
		databases: collectRequirements(
			"databases",
			declarations,
			(declaration) => declaration.databases,
		),
		secrets: collectRequirements(
			"secrets",
			declarations,
			(declaration) => declaration.secrets,
		),
	}
}

export function resourcesForConsumer<
	Connection extends Resources["connections"][string],
	Database extends Resources["databases"][string],
	Secret extends Resources["secrets"][string],
>(
	resources: {
		connections: Record<string, Connection>
		databases: Record<string, Database>
		secrets: Record<string, Secret>
	},
	consumer: ResourceConsumer,
) {
	return {
		connections: filterRequirements(resources.connections, consumer),
		databases: filterRequirements(resources.databases, consumer),
		secrets: filterRequirements(resources.secrets, consumer),
	}
}

function filterRequirements<T extends { consumers: ResourceConsumer[] }>(
	requirements: Record<string, T>,
	consumer: ResourceConsumer,
) {
	return Object.fromEntries(
		Object.entries(requirements).filter(([, requirement]) =>
			requirement.consumers.some(
				(declared) =>
					declared.type === consumer.type &&
					(consumer.type === "app" ||
						(declared.type === "agent" && declared.name === consumer.name)),
			),
		),
	)
}

function collectRequirements<T extends { mode: CredentialMode; toolkit?: string }>(
	category: keyof Declaration,
	declarations: { consumer: ResourceConsumer; declaration: Declaration }[],
	select: (declaration: Declaration) => Record<string, T>,
) {
	const resources = new Map<string, T & { consumers: ResourceConsumer[] }>()
	for (const { consumer, declaration } of declarations) {
		for (const [key, requirement] of Object.entries(select(declaration))) {
			const existing = resources.get(key)
			if (!existing) {
				resources.set(key, { ...requirement, consumers: [consumer] })
				continue
			}
			if (
				existing.mode !== requirement.mode ||
				existing.toolkit !== requirement.toolkit
			) {
				throw new z.ZodError([
					{
						code: "custom",
						message: `Conflicting ${category} requirement "${key}": declarations must agree on mode${category === "connections" ? " and toolkit" : ""}`,
						path: [
							...(consumer.type === "app" ? ["app"] : ["agents", consumer.name]),
							category,
							key,
						],
					},
				])
			}
			existing.consumers.push(consumer)
		}
	}
	return Object.fromEntries(resources)
}
