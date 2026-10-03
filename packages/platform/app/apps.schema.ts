import { z } from "@hono/zod-openapi"
import type { AppId } from "@/database/models/public/App"

const reservedSubdomains = ["local", "auth"]

export const publicHostnameSchema = z
	.hostname()
	.toLowerCase()
	.refine(
		(hostname) => !reservedSubdomains.some((name) => name === hostname.split(".")[0]),
		{
			message: "This subdomain is reserved",
		},
	)

export const appSchema = z
	.object({
		id: z.uuid().transform((id) => id as AppId),
		owner_organization_id: z.string().min(1).nullable(),
		owner_user_id: z.string().min(1).nullable(),
		public_hostname: publicHostnameSchema,
	})
	.openapi("App")

export const listedAppSchema = appSchema.extend({ latest_commit: z.string().nullable() })
