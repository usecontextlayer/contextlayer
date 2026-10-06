import { appConnectionsSchema as requirementsResponseSchema } from "@usecontextlayer/shared/app-connections"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"

export const assignmentSchema = z.object({
	connection_id: z.string().min(1),
	slug: z
		.string()
		.min(1)
		.transform((slug) => slug as AppConnectionAssignmentSlug),
})
export const assignAppConnectionRequestSchema = z.strictObject(assignmentSchema.shape)

export const appConnectionsSchema = requirementsResponseSchema.extend({
	app: appSchema,
})
