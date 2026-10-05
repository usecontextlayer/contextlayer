import { type AuthIdentity, listOrganizations } from "@/auth.server"
import type { Owner } from "@/owner"

export async function authorizeOwner(
	identity: AuthIdentity,
	issuer: string,
	owner: Owner,
) {
	if (owner.type === "user") return owner.id === identity.user.id
	const organizations = await listOrganizations(identity, issuer)
	return organizations.some((organization) => organization.id === owner.id)
}
