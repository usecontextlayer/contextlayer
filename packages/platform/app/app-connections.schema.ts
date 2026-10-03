import { z } from "zod"
import { appSchema } from "@/apps.schema"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"

const modeSchema = z.enum(["individual", "shared"])

export const requirementSchema = z.object({
	description: z.string().min(1).optional(),
	mode: modeSchema,
	toolkit: z.string().min(1),
	tools: z.object({ allow: z.array(z.string().min(1)) }).optional(),
})

export const slateSchema = z.object({
	connections: z.record(z.string().min(1), requirementSchema).default({}),
	folders: z.record(z.string().min(1), z.object({ mode: modeSchema })).default({}),
})

export const appConnectionsRequestSchema = z.object({ manifest: slateSchema.optional() })
export const assignmentSchema = z.object({
	connection_id: z.string().min(1),
	slug: z
		.string()
		.min(1)
		.transform((slug) => slug as AppConnectionAssignmentSlug),
})
export const appConnectionsSchema = z.object({
	app: appSchema,
	connections: z.array(
		requirementSchema.extend({
			connection_id: z.string().nullable(),
			slug: z.string(),
		}),
	),
})
