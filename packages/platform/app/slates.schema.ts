import { z } from "@hono/zod-openapi"
import { slateTargetSchema as portableSlateTargetSchema } from "@usecontextlayer/shared/slates"
import type { SlateId } from "@/database/models/public/Slate"
import type { Owner } from "@/owner"

const reservedSubdomains = ["local", "auth"]

export const slateVisibilitySchema = z.enum(["public", "private"])
export const DEFAULT_SLATE_VISIBILITY = "private"

export const publicHostnameSchema = z
	.hostname()
	.toLowerCase()
	.refine(
		(hostname) => !reservedSubdomains.some((name) => name === hostname.split(".")[0]),
		{
			message: "This subdomain is reserved",
		},
	)

export const slateSchema = z
	.object({
		id: z.uuid().transform((id) => id as SlateId),
		owner_organization_id: z.string().min(1).nullable(),
		owner_user_id: z.string().min(1).nullable(),
		public_hostname: publicHostnameSchema,
		visibility: slateVisibilitySchema,
	})
	.openapi("Slate")

export const listedSlateSchema = slateSchema.extend({
	latest_commit: z.string().nullable(),
})

export type Slate = z.infer<typeof slateSchema>
export const createSlateRequestSchema = z.strictObject({
	organization_slug: z.string().min(1).optional(),
})
export type CreateSlateRequest = z.infer<typeof createSlateRequestSchema>
export const updateSlateVisibilityRequestSchema = z.strictObject({
	visibility: slateVisibilitySchema,
})
export type UpdateSlateVisibilityRequest = z.infer<
	typeof updateSlateVisibilityRequestSchema
>
export const slateTargetSchema = portableSlateTargetSchema.transform((target) =>
	"id" in target ? { id: target.id as SlateId } : target,
)
export type SlateTarget = z.infer<typeof slateTargetSchema>
export const resolveSlateQuerySchema = z.object({
	hostname: z.hostname().toLowerCase(),
	pathname: z
		.string()
		.startsWith("/")
		.openapi({ description: "Incoming slate URL pathname" }),
})

export const listSlatesQuerySchema = z
	.strictObject({
		owner_organization_id: slateSchema.shape.owner_organization_id
			.unwrap()
			.min(1)
			.optional()
			.openapi({ description: "Filter by the owning Better Auth organization ID" }),
		owner_user_id: slateSchema.shape.owner_user_id
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
export type SlateOwnerFilter = Owner | { type: "all" }
