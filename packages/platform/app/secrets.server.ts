import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import { z } from "zod"
import type { OwnerIdentity } from "@/auth.server"
import type { PlatformEnv } from "@/context"
import { type PlatformBindings, type PlatformConfig, parseSharedSecretsEnv } from "@/env"
import type { Owner } from "@/owner"
import { authorizeOwner } from "@/owner.server"
import type { SetSecretRequest } from "@/secrets.schema"

function secretKeyPrefix(type: Owner["type"]) {
	// The config token spans Owners; these prefixes identify secrets, not access rights.
	return `OWNER_${type.toUpperCase()}_`
}

export function secretKey(owner: Owner, name: string) {
	const id = Buffer.from(owner.id, "utf8").toString("hex").toUpperCase()
	return `${secretKeyPrefix(owner.type)}${id}_${name}`
}

export function isSecretKey(key: string, name: string) {
	const suffix = `_${name}`
	return (
		key.endsWith(suffix) &&
		ownerSchema.options.some(({ shape }) => {
			const prefix = secretKeyPrefix(shape.type.value)
			return (
				key.startsWith(prefix) &&
				/^(?:[0-9A-F]{2})+$/.test(key.slice(prefix.length, -suffix.length))
			)
		})
	)
}

export async function listSharedSecretNames(config: PlatformBindings) {
	const vault = parseSharedSecretsEnv(config)
	const url = new URL("https://api.doppler.com/v3/configs/config/secrets/names")
	url.search = new URLSearchParams({
		config: vault.CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG,
		project: vault.CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT,
	}).toString()
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${vault.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN}` },
	})
	if (!response.ok) throw new Error(`Secret names load failed: HTTP ${response.status}`)
	return new Set(
		z.object({ names: z.array(z.string()) }).parse(await response.json()).names,
	)
}

export async function loadSharedSecret(
	config: PlatformBindings,
	owner: Owner,
	name: string,
) {
	const vaultConfig = parseSharedSecretsEnv(config)
	const url = new URL("https://api.doppler.com/v3/configs/config/secret")
	url.search = new URLSearchParams({
		config: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG,
		name: secretKey(owner, name),
		project: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT,
	}).toString()
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN}`,
		},
	})
	if (!response.ok) throw new Error(`Secret load failed: HTTP ${response.status}`)
	const { value } = z
		.object({ value: z.object({ raw: z.string().nullable() }) })
		.parse(await response.json())
	if (value.raw === null) {
		const setup =
			owner.type === "personal"
				? `Sign in as that user and run: ctx secrets set ${name}`
				: `As a member of that organization, run: ctx secrets --org <organization-slug> set ${name}`
		throw new Error(
			`Secret ${name} is not configured for ${owner.type} Owner ${owner.id}. ${setup}`,
		)
	}
	return value.raw
}

export async function setSharedSecret(
	meridian: PlatformEnv["Bindings"]["MERIDIAN"],
	config: PlatformConfig,
	identity: OwnerIdentity,
	owner: Owner,
	name: string,
	input: SetSecretRequest,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	const vaultConfig = parseSharedSecretsEnv(config)
	const response = await fetch("https://api.doppler.com/v3/configs/config/secrets", {
		body: JSON.stringify({
			config: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG,
			project: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT,
			secrets: { [secretKey(owner, name)]: input.value },
		}),
		headers: {
			authorization: `Bearer ${vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN}`,
			"content-type": "application/json",
		},
		method: "POST",
	})
	if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`)
	if (name === "CLAUDE_CODE_OAUTH_TOKEN")
		await meridian.getByName("shared").refreshProfiles()
	return { allowed: true, secret: { name, owner } } as const
}

export async function dropSharedSecret(
	meridian: PlatformEnv["Bindings"]["MERIDIAN"],
	config: PlatformConfig,
	identity: OwnerIdentity,
	owner: Owner,
	name: string,
) {
	if (!(await authorizeOwner(identity, config.CTX_AUTH_ISSUER, owner)))
		return { allowed: false } as const
	const vaultConfig = parseSharedSecretsEnv(config)
	const url = new URL("https://api.doppler.com/v3/configs/config/secret")
	url.search = new URLSearchParams({
		config: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG,
		name: secretKey(owner, name),
		project: vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT,
	}).toString()
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${vaultConfig.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN}`,
		},
		method: "DELETE",
	})
	if (!response.ok) throw new Error(`Secret drop failed: HTTP ${response.status}`)
	if (name === "CLAUDE_CODE_OAUTH_TOKEN")
		await meridian.getByName("shared").refreshProfiles()
	return { allowed: true, secret: { name, owner } } as const
}

export function secretKeyRef(key: string) {
	return createHash("sha256").update(key).digest("hex")
}

export async function loadMeridianProfiles(config: PlatformBindings) {
	const vault = parseSharedSecretsEnv(config)
	const url = new URL("https://api.doppler.com/v3/configs/config/secrets")
	url.search = new URLSearchParams({
		config: vault.CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG,
		project: vault.CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT,
	}).toString()
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${vault.CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN}` },
	})
	if (!response.ok)
		throw new Error(`Subscription profiles load failed: HTTP ${response.status}`)
	const { secrets } = z
		.object({
			secrets: z.record(z.string(), z.object({ raw: z.string() })),
		})
		.parse(await response.json())
	return [
		// Keep the first profile invalid: an unknown profile must never borrow an Owner's token.
		{ id: "unconfigured", oauthToken: "deliberately-invalid" },
		...Object.entries(secrets)
			.filter(([key]) => isSecretKey(key, "CLAUDE_CODE_OAUTH_TOKEN"))
			.map(([key, value]) => ({ id: secretKeyRef(key), oauthToken: value.raw })),
	]
}
