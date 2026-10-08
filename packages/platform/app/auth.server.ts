import {
	parseAccessTokenAuthorization,
	requestToResourceInput,
	verifyAccessTokenRequest,
} from "better-auth/oauth2"
import type { JWTPayload } from "jose"
import { z } from "zod"

export const userSchema = z.object({ id: z.string().min(1) })
const sessionSchema = z.object({ user: userSchema }).nullable()

type OAuthCredential = {
	type: "access-token"
	token: string
	claims: JWTPayload
	resource: string
}

export type OwnerIdentity = {
	type: "owner"
	user: z.infer<typeof userSchema>
	credential: OAuthCredential | { type: "cookie"; cookie: string }
}

export type ViewerIdentity = {
	type: "viewer"
	user: z.infer<typeof userSchema>
	credential: OAuthCredential | { type: "session"; token: string }
}

export type AuthIdentity = OwnerIdentity | ViewerIdentity

export function credentialHeaders(credential: AuthIdentity["credential"]) {
	const headers = new Headers()
	if (credential.type === "access-token") {
		headers.set("Authorization", `Bearer ${credential.token}`)
	} else if (credential.type === "session") {
		headers.set("Cookie", `ctx-viewer-auth=${encodeURIComponent(credential.token)}`)
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

export async function listOrganizations(identity: OwnerIdentity, issuer: string) {
	const url = new URL(issuer)
	url.pathname = "/api/platform/organizations"
	const response = await fetch(url, { headers: credentialHeaders(identity.credential) })
	if (!response.ok) throw new Error(`Organization lookup failed: ${response.status}`)
	return z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await response.json()).organizations
}

export async function checkViewerOrganizationMembership(
	identity: ViewerIdentity,
	organizationId: string,
	issuer: string,
) {
	const url = new URL(
		`/api/viewer/organizations/${encodeURIComponent(organizationId)}/membership`,
		issuer,
	)
	if (identity.credential.type === "access-token") {
		url.searchParams.set("resource", identity.credential.resource)
	}
	const response = await fetch(url, { headers: credentialHeaders(identity.credential) })
	if (!response.ok) throw new Error(`Membership lookup failed: ${response.status}`)
	return z.object({ isMember: z.boolean() }).parse(await response.json()).isMember
}

export async function authenticateAccessToken(
	request: Request,
	issuer: string,
): Promise<OwnerIdentity> {
	const resource = "https://slate.usecontextlayer.com"
	const claims = await verifyAccessTokenRequest(requestToResourceInput(request), {
		jwksUrl: `${issuer.replace(/\/$/, "")}/jwks`,
		requiredScopes: ["platform:access"],
		verifyOptions: {
			audience: resource,
			issuer,
			requiredClaims: ["sub", "exp", "scope"],
		},
	})
	const token = z
		.string()
		.min(1)
		.parse(parseAccessTokenAuthorization(request.headers.get("authorization"))?.token)
	return {
		credential: { claims, resource, token, type: "access-token" },
		type: "owner",
		user: userSchema.parse({ id: claims.sub }),
	}
}

export async function authenticateSession(
	credential: Exclude<AuthIdentity["credential"], { type: "access-token" }>,
	issuer: string,
): Promise<AuthIdentity | null> {
	const headers = credentialHeaders(credential)
	if (credential.type === "session") {
		headers.delete("Cookie")
		headers.set("Authorization", `Bearer ${credential.token}`)
	}
	const response = await fetch(`${issuer.replace(/\/$/, "")}/get-session`, {
		headers,
	})
	if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`)
	const user = sessionSchema.parse(await response.json())?.user
	if (!user) return null
	return credential.type === "cookie"
		? { credential, type: "owner", user }
		: { credential, type: "viewer", user }
}

export async function findOrganizationBySlug(
	identity: OwnerIdentity,
	issuer: string,
	slug: string,
) {
	const organizations = await listOrganizations(identity, issuer)
	return organizations.find((organization) => organization.slug === slug)
}

export async function getCurrentUser(identity: OwnerIdentity, issuer: string) {
	const response = await fetch(new URL("/api/me", issuer), {
		headers: credentialHeaders(identity.credential),
	})
	if (!response.ok) throw new Error(`Profile lookup failed: ${response.status}`)
	return userSchema
		.extend({ image: z.string().nullable(), name: z.string() })
		.parse(await response.json())
}
