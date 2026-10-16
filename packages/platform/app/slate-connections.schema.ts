import { slateConnectionsSchema as requirementsResponseSchema } from "@usecontextlayer/shared/slate-connections"
import { z } from "zod"
import type {
	SlateConnectionAssignmentOwnerId,
	SlateConnectionAssignmentOwnerType,
	SlateConnectionAssignmentSlug,
} from "@/database/models/public/SlateConnectionAssignment"
import type { Owner } from "@/owner"
import { slateSchema } from "@/slates.schema"

export function assignmentOwner(owner: Owner) {
	return {
		owner_id: owner.id as SlateConnectionAssignmentOwnerId,
		owner_type: owner.type as SlateConnectionAssignmentOwnerType,
	}
}

export const assignmentSchema = z.object({
	connection_id: z.string().min(1),
	slug: z
		.string()
		.min(1)
		.transform((slug) => slug as SlateConnectionAssignmentSlug),
})
export const assignSlateConnectionRequestSchema = z.strictObject(assignmentSchema.shape)

export const slateConnectionsSchema = requirementsResponseSchema.extend({
	slate: slateSchema,
})
