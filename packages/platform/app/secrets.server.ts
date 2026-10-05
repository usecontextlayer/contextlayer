import { Buffer } from "node:buffer"
import { type AuthIdentity, listOrganizations } from "@/auth.server"
import { type PlatformConfig, parseSharedSecretsEnv } from "@/env"
import type { Owner } from "@/owner"
import type { SetSecretRequest } from "@/secrets.schema"

async function authorizeOwner(identity: AuthIdentity, issuer: string, owner: Owner) {
	// The vault token spans every Owner in its config; key prefixes cannot authorize access.
	if (owner.type === "user") return owner.id === identity.user.id
	const organizations = await listOrganizations(identity, issuer)
	return organizations.some((organization) => organization.id === owner.id)
}

export function secretKey(owner: Owner, name: string) {
	const id = Buffer.from(owner.id, "utf8").toString("hex").toUpperCase()
	return `OWNER_${owner.type.toUpperCase()}_${id}_${name}`
}

export async function setSharedSecret(
	config: PlatformConfig,
	identity: AuthIdentity,
	owner: Owner,
	name: string,
	input: SetSecretRequest,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	const vaultConfig = parseSharedSecretsEnv(config)
	const response = await fetch("https://api.doppler.com/v3/configs/config/secrets", {
		body: JSON.stringify({
			config: vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG,
			project: vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT,
			secrets: { [secretKey(owner, name)]: input.value },
		}),
		headers: {
			authorization: `Bearer ${vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN}`,
			"content-type": "application/json",
		},
		method: "POST",
	})
	if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`)
	return { allowed: true, secret: { name, owner } } as const
}

export async function dropSharedSecret(
	config: PlatformConfig,
	identity: AuthIdentity,
	owner: Owner,
	name: string,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	const vaultConfig = parseSharedSecretsEnv(config)
	const url = new URL("https://api.doppler.com/v3/configs/config/secret")
	url.search = new URLSearchParams({
		config: vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG,
		name: secretKey(owner, name),
		project: vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT,
	}).toString()
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${vaultConfig.CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN}`,
		},
		method: "DELETE",
	})
	if (!response.ok) throw new Error(`Secret drop failed: HTTP ${response.status}`)
	return { allowed: true, secret: { name, owner } } as const
}
