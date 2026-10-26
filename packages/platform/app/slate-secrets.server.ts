import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { PlatformConfig } from "@/env"
import { getCredentialOwner } from "@/owner"
import type { SetSecretRequest } from "@/secrets.schema"
import { setSharedSecret } from "@/secrets.server"
import type { SlateDeclarationSnapshot } from "@/slate-declarations.server"
import { addSlateMember } from "@/slate-members.server"
import type { OwnerSlateAccess } from "@/slates.server"

export async function setSlateSecret(
	db: PlatformDb,
	memberProvisioning: PlatformEnv["Bindings"]["MEMBER_PROVISIONING"],
	meridian: PlatformEnv["Bindings"]["MERIDIAN"],
	config: PlatformConfig,
	access: OwnerSlateAccess,
	name: string,
	input: SetSecretRequest,
	snapshot: SlateDeclarationSnapshot,
) {
	const requirement = snapshot.resources.secrets[name]
	if (!requirement) return { allowed: false, reason: "not-found" } as const
	const owner = getCredentialOwner(requirement.mode, access.slate, access.identity.user)
	const saved = await setSharedSecret(
		meridian,
		config,
		access.identity,
		owner,
		name,
		input,
	)
	if (!saved.allowed) return { allowed: false, reason: "forbidden" } as const
	await addSlateMember(
		db,
		memberProvisioning,
		config,
		access.slate,
		access.identity.user,
		snapshot,
	)
	return saved
}
