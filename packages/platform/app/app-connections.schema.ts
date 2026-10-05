import { appConnectionsSchema as requirementsResponseSchema } from "@usecontextlayer/shared/app-connections"
import { slateSchema } from "@usecontextlayer/shared/slate"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import type { AppConnectionAssignmentSlug } from "@/database/models/public/AppConnectionAssignment"

export const appConnectionsRequestSchema = z.object({ manifest: slateSchema.optional() })
export const assignmentSchema = z.object({
	connection_id: z.string().min(1),
	slug: z
		.string()
		.min(1)
		.transform((slug) => slug as AppConnectionAssignmentSlug),
})
export const assignAppConnectionRequestSchema = assignmentSchema.extend({
	manifest: slateSchema.optional(),
})

export const appConnectionsSchema = requirementsResponseSchema.extend({
	app: appSchema,
})
