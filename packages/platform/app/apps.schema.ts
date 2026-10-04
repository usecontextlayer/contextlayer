import { z } from "@hono/zod-openapi"
import type { AppId } from "@/database/models/public/App"
import type { Owner } from "@/owner"

const reservedSubdomains = ["local", "auth"]

export const appVisibilitySchema = z.enum(["public", "private"])
export const DEFAULT_APP_VISIBILITY = "private"

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
		visibility: appVisibilitySchema,
	})
	.openapi("App")

export const listedAppSchema = appSchema.extend({ latest_commit: z.string().nullable() })

export type App = z.infer<typeof appSchema>
export const createAppRequestSchema = z.strictObject({
	organization_slug: z.string().min(1).optional(),
})
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>
export const appTargetSchema = z.union([
	appSchema.shape.id.transform((id) => ({ id })),
	appSchema.shape.public_hostname.transform((public_hostname) => ({ public_hostname })),
])
export type AppTarget = z.infer<typeof appTargetSchema>
export const resolveAppQuerySchema = z.object({ hostname: z.hostname().toLowerCase() })

export const listAppsQuerySchema = z
	.strictObject({
		owner_organization_id: appSchema.shape.owner_organization_id
			.unwrap()
			.min(1)
			.optional()
			.openapi({ description: "Filter by the owning Better Auth organization ID" }),
		owner_user_id: appSchema.shape.owner_user_id
			.unwrap()
			.min(1)
			.optional()
			.openapi({ description: "Filter by the owning Better Auth user ID" }),
	})
	.refine(
		(query) =>
			query.owner_user_id === undefined || query.owner_organization_id === undefined,
		{ message: "Supply either owner_user_id or owner_organization_id, not both" },
	)
export type AppOwnerFilter = Owner | { type: "all" }
