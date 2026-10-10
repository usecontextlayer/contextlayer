import type { Owner } from "@usecontextlayer/shared/slate-usage"
import { z } from "zod"
import { getCurrentUser, listOrganizations } from "@/auth"
import { env } from "@/env"

export const ownerOptionsSchema = z.object({ org: z.string().min(1).optional() })

export async function resolveOwner(
	org: string | undefined,
	headers: HeadersInit,
): Promise<Owner> {
	if (!org) return { id: (await getCurrentUser(env, headers)).id, type: "personal" }
	const organizations = await listOrganizations(env, headers)
	const organization = organizations.find((organization) => organization.slug === org)
	if (!organization) throw new Error("Organization is not in your memberships")
	return { id: organization.id, type: "organization" }
}

export function ownerPath(owner: Owner) {
	return `${owner.type === "organization" ? "org" : "personal"}/${encodeURIComponent(owner.id)}`
}
