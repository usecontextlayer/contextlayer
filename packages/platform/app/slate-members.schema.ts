import { z } from "@hono/zod-openapi"
import type { SlateMemberUserId } from "@/database/models/public/SlateMember"
import { slateSchema } from "@/slates.schema"

export const slateMemberSchema = z
	.object({
		slate_id: slateSchema.shape.id,
		user_id: z
			.string()
			.min(1)
			.transform((id) => id as SlateMemberUserId),
	})
	.openapi("SlateMember")
