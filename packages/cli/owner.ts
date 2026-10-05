import type { Owner } from "@usecontextlayer/shared/app-usage"
import { z } from "zod"
import { getCurrentUser } from "@/auth"
import { env } from "@/env"

export const ownerOptionsSchema = z.object({ org: z.string().min(1).optional() })

export async function resolveOwner(
	org: string | undefined,
	headers: HeadersInit,
): Promise<Owner> {
	if (!org) return { id: (await getCurrentUser(headers)).id, type: "user" }
	const response = await fetch(
		new URL("/api/platform/organizations", env.CTX_AUTH_ISSUER),
		{
			headers,
		},
	)
	if (!response.ok) throw new Error(`Organization lookup failed: HTTP ${response.status}`)
	const { organizations } = z
		.object({
			organizations: z.array(z.object({ id: z.string().min(1), slug: z.string() })),
		})
		.parse(await response.json())
	const organization = organizations.find((organization) => organization.slug === org)
	if (!organization) throw new Error("Organization is not in your memberships")
	return { id: organization.id, type: "organization" }
}

export function ownerPath(owner: Owner) {
	return `${owner.type === "organization" ? "org" : "user"}/${encodeURIComponent(owner.id)}`
}
