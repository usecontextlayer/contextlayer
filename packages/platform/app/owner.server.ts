import { listOrganizations, type OwnerIdentity } from "@/auth.server"
import type { Owner } from "@/owner"

export async function authorizeOwner(
	identity: OwnerIdentity,
	issuer: string,
	owner: Owner,
) {
	if (owner.type === "user") return owner.id === identity.user.id
	const organizations = await listOrganizations(identity, issuer)
	return organizations.some((organization) => organization.id === owner.id)
}
