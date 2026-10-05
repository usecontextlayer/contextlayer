import { z } from "@hono/zod-openapi"
import { appSchema } from "@/apps.schema"
import type { AppMemberUserId } from "@/database/models/public/AppMember"

export const appMemberSchema = z
	.object({
		app_id: appSchema.shape.id,
		user_id: z
			.string()
			.min(1)
			.transform((id) => id as AppMemberUserId),
	})
	.openapi("AppMember")
