import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

export const userSchema = z.object({ id: z.string().min(1) })
const claimsSchema = z.object({ scope: z.string(), sub: z.string().min(1) })
const sessionSchema = z.object({ user: userSchema }).nullable()

export type AuthIdentity = {
	user: z.infer<typeof userSchema>
	credential:
		| { type: "access-token"; token: string }
		| { type: "session"; token: string }
		| { type: "cookie"; cookie: string }
}

export function credentialHeaders(credential: AuthIdentity["credential"]) {
	const headers = new Headers()
	if (credential.type === "access-token") {
		headers.set("Authorization", `Bearer ${credential.token}`)
	} else if (credential.type === "session") {
		headers.set("Cookie", `__Secure-ctx_viewer=${encodeURIComponent(credential.token)}`)
	} else {
		headers.set("Cookie", credential.cookie)
	}
	return headers
}

export const organizationSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	slug: z.string().min(1),
})
export type Organization = z.infer<typeof organizationSchema>

export async function listOrganizations(identity: AuthIdentity, issuer: string) {
	const url = new URL(issuer)
	url.pathname = "/api/platform/organizations"
	const response = await fetch(url, { headers: credentialHeaders(identity.credential) })
	if (!response.ok) throw new Error(`Organization lookup failed: ${response.status}`)
	return z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await response.json()).organizations
}

export async function authenticateAccessToken(token: string, issuer: string) {
	const keys = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/jwks`))
	const { payload } = await jwtVerify(token, keys, {
		audience: "urn:ctx:platform",
		issuer,
		requiredClaims: ["sub", "exp", "scope"],
	})
	const claims = claimsSchema.parse(payload)
	return claims.scope.split(" ").includes("ctx:access") ? { id: claims.sub } : null
}

export async function authenticateSession(
	credential: Exclude<AuthIdentity["credential"], { type: "access-token" }>,
	issuer: string,
) {
	const headers = credentialHeaders(credential)
	if (credential.type === "session") {
		headers.delete("Cookie")
		headers.set("Authorization", `Bearer ${credential.token}`)
	}
	const response = await fetch(`${issuer.replace(/\/$/, "")}/get-session`, {
		headers,
	})
	if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`)
	return sessionSchema.parse(await response.json())?.user ?? null
}

export async function findOrganizationBySlug(
	identity: AuthIdentity,
	issuer: string,
	slug: string,
) {
	const organizations = await listOrganizations(identity, issuer)
	return organizations.find((organization) => organization.slug === slug)
}
