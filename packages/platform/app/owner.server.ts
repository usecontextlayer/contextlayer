import {
	type AuthIdentity,
	hasManagementAuthority,
	listOrganizations,
} from "@/auth.server"
import type { Owner } from "@/owner"

export async function authorizeOwner(
	identity: AuthIdentity,
	issuer: string,
	owner: Owner,
) {
	if (!hasManagementAuthority(identity)) return false
	if (owner.type === "personal") return owner.id === identity.user.id
	const organizations = await listOrganizations(identity, issuer)
	return organizations.some((organization) => organization.id === owner.id)
}
