import { z } from "zod"

export const credentialModeSchema = z.enum(["viewer", "owner"])
export type CredentialMode = z.infer<typeof credentialModeSchema>

export const connectionRequirementSchema = z.strictObject({
	mode: credentialModeSchema,
	toolkit: z.string().min(1),
})
export const secretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
export const secretRequirementSchema = z.strictObject({ mode: credentialModeSchema })
export const folderRequirementSchema = z.strictObject({ mode: credentialModeSchema })

export const slateSchema = z.strictObject({
	connections: z.record(z.string().min(1), connectionRequirementSchema),
	folders: z.record(z.string().min(1), folderRequirementSchema).default({}),
	secrets: z.record(secretNameSchema, secretRequirementSchema).default({}),
})
export type Slate = z.infer<typeof slateSchema>

export const appSlatesSchema = z.strictObject({
	agents: z.record(z.string().min(1), slateSchema),
	app: slateSchema,
})
export type AppSlates = z.infer<typeof appSlatesSchema>

export const resourceConsumerSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("app") }),
	z.strictObject({ name: z.string().min(1), type: z.literal("agent") }),
])
export type ResourceConsumer = z.infer<typeof resourceConsumerSchema>

export type Resources = {
	[Kind in keyof Slate]: Record<
		string,
		Slate[Kind][string] & { consumers: ResourceConsumer[] }
	>
}

export function collectAppResources(slates: AppSlates): Resources {
	const declarations: { consumer: ResourceConsumer; slate: Slate }[] = [
		{ consumer: { type: "app" }, slate: slates.app },
		...Object.entries(slates.agents).map(([name, slate]) => ({
			consumer: { name, type: "agent" as const },
			slate,
		})),
	]
	return {
		connections: collectRequirements(
			"connections",
			declarations,
			(slate) => slate.connections,
		),
		folders: collectRequirements("folders", declarations, (slate) => slate.folders),
		secrets: collectRequirements("secrets", declarations, (slate) => slate.secrets),
	}
}

export function resourcesForConsumer(
	resources: Resources,
	consumer: ResourceConsumer,
): Resources {
	return {
		connections: filterRequirements(resources.connections, consumer),
		folders: filterRequirements(resources.folders, consumer),
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
	category: keyof Slate,
	declarations: { consumer: ResourceConsumer; slate: Slate }[],
	select: (slate: Slate) => Record<string, T>,
) {
	const resources = new Map<string, T & { consumers: ResourceConsumer[] }>()
	for (const { consumer, slate } of declarations) {
		for (const [name, requirement] of Object.entries(select(slate))) {
			const existing = resources.get(name)
			if (!existing) {
				resources.set(name, { ...requirement, consumers: [consumer] })
				continue
			}
			if (
				existing.mode !== requirement.mode ||
				existing.toolkit !== requirement.toolkit
			) {
				throw new z.ZodError([
					{
						code: "custom",
						message: `Conflicting ${category} requirement "${name}": declarations must agree on mode${category === "connections" ? " and toolkit" : ""}`,
						path: [
							...(consumer.type === "app" ? ["app"] : ["agents", consumer.name]),
							category,
							name,
						],
					},
				])
			}
			existing.consumers.push(consumer)
		}
	}
	return Object.fromEntries(resources)
}
