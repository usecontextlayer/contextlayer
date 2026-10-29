import { agentRunSchema } from "@usecontextlayer/shared/agents"
import { localResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { z } from "zod"

export const localSnapshotSchema = z.strictObject({
	agents: z.record(
		z.string(),
		z.object({
			instructions: z.string(),
			schedules: z.record(z.string().min(1), z.string()),
		}),
	),
	configuration: localResourceConfigurationSchema,
	gateway: z
		.object({
			platformUrl: z.url(),
			slateId: z.uuid(),
			token: z.string().min(1),
		})
		.nullable(),
	scope: z.string().min(1),
	source: z.literal("working-tree"),
})
export type LocalSnapshot = z.infer<typeof localSnapshotSchema>

export const localAgentRunSchema = agentRunSchema.extend({
	connections: z.record(
		z.string(),
		z.object({
			account_id: z.string().min(1),
			toolkit: z.string().min(1),
		}),
	),
	databases: z.record(z.string(), z.object({ instance_name: z.string().min(1) })),
	secrets: z.record(z.string(), z.object({ ref: z.string().min(1) })),
})
