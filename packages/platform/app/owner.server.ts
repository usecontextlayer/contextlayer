import {
	type AuthIdentity,
	listOrganizations,
	type PlatformCredential,
} from "@/auth.server"
import type { Owner } from "@/owner"

export async function authorizeOwner(
	identity: AuthIdentity<PlatformCredential>,
	issuer: string,
	owner: Owner,
) {
	if (owner.type === "personal") return owner.id === identity.user.id
	const organizations = await listOrganizations(identity, issuer)
	return organizations.some((organization) => organization.id === owner.id)
}
