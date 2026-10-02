import { z } from "@hono/zod-openapi"
import type { AppId } from "@/database/models/public/App"

export const appSchema = z
	.object({
		id: z.uuid().transform((id) => id as AppId),
		public_hostname: z.hostname(),
	})
	.openapi("App")

export const listedAppSchema = appSchema.extend({ latest_commit: z.string().nullable() })
