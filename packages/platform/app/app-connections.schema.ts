import { z } from "zod"
import { appSchema } from "@/apps.schema"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"

export const requirementSchema = z.object({
	mode: z.enum(["individual", "shared"]),
	toolkit: z.string().min(1),
})

export const slateSchema = z.object({
	connections: z.record(z.string().min(1), requirementSchema),
})

export const appTargetSchema = z.union([
	appSchema.shape.id.transform((id) => ({ id })),
	appSchema.shape.public_hostname.transform((public_hostname) => ({ public_hostname })),
])

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
