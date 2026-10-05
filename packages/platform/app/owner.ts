import { type Owner, ownerSchema } from "@usecontextlayer/shared/app-usage"
import type { z } from "zod"
import type { App } from "@/apps.schema"
import type { organizationSchema } from "@/auth.server"

export type { Owner }

export function getAppOwner(app: App): Owner {
	return ownerSchema.parse(
		app.owner_user_id !== null
			? { id: app.owner_user_id, type: "user" }
			: { id: app.owner_organization_id, type: "organization" },
	)
}

export type OwnerDetails =
	| Extract<Owner, { type: "user" }>
	| (Extract<Owner, { type: "organization" }> &
			Pick<z.infer<typeof organizationSchema>, "name" | "slug">)
