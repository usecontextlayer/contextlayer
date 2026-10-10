import type { CredentialMode } from "@usecontextlayer/shared/declaration"
import { type Owner, ownerSchema } from "@usecontextlayer/shared/slate-usage"
import type { z } from "zod"
import type { organizationSchema } from "@/auth.server"
import type { Slate } from "@/slates.schema"

export type { Owner }

export function getSlateOwner(slate: Slate): Owner {
	return ownerSchema.parse(
		slate.owner_user_id !== null
			? { id: slate.owner_user_id, type: "personal" }
			: { id: slate.owner_organization_id, type: "organization" },
	)
}

export type OwnerDetails =
	| Extract<Owner, { type: "personal" }>
	| (Extract<Owner, { type: "organization" }> &
			Pick<z.infer<typeof organizationSchema>, "name" | "slug">)

export function getCredentialOwner(
	mode: CredentialMode,
	slate: Slate,
	viewer: { id: string } | null,
): Owner {
	if (mode === "owner") return getSlateOwner(slate)
	if (!viewer) throw new Error("Viewer-scoped resources require a user run actor")
	return { id: viewer.id, type: "personal" }
}
