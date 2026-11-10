import {
	parseAccessTokenAuthorization,
	type ResourceRequestInput,
	verifyAccessTokenRequest,
} from "better-auth/oauth2"
import type { JWTPayload } from "jose"
import { z } from "zod"

export const userSchema = z.object({ id: z.string().min(1) })
const sessionSchema = z.object({ user: userSchema }).nullable()

export const PLATFORM_RESOURCE = "https://platform.usecontextlayer.com"
export const PLATFORM_SCOPE = "platform:access"

export type WebSessionCredential = { type: "web-session"; cookie: string }
export type ViewerSessionCredential = { type: "viewer-session"; token: string }
export type PlatformOAuthCredential = {
	type: "platform-oauth"
	token: string
	claims: JWTPayload
}
export type SlateMcpOAuthCredential = {
	type: "slate-mcp-oauth"
	token: string
	claims: JWTPayload
	resource: string
}
export type Credential =
	| WebSessionCredential
	| ViewerSessionCredential
	| PlatformOAuthCredential
	| SlateMcpOAuthCredential
export type PlatformCredential = WebSessionCredential | PlatformOAuthCredential
export type ViewerCredential = ViewerSessionCredential | SlateMcpOAuthCredential

export type AuthIdentity<C extends Credential = Credential> = C extends Credential
	? { user: z.infer<typeof userSchema>; credential: C }
	: never

export function hasPlatformCredential(
	identity: AuthIdentity,
): identity is AuthIdentity<PlatformCredential> {
	return (
		identity.credential.type === "web-session" ||
		identity.credential.type === "platform-oauth"
	)
}

export function credentialHeaders(credential: Credential) {
	const headers = new Headers()
	switch (credential.type) {
		case "platform-oauth":
		case "slate-mcp-oauth":
			headers.set("Authorization", `Bearer ${credential.token}`)
			break
		case "viewer-session":
			headers.set("Cookie", `ctx-viewer-auth=${encodeURIComponent(credential.token)}`)
			break
		case "web-session":
			headers.set("Cookie", credential.cookie)
			break
	}
	return headers
}

export const organizationSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	slug: z.string().min(1),
})
export type Organization = z.infer<typeof organizationSchema>

export async function listOrganizations(
	identity: AuthIdentity<PlatformCredential>,
	issuer: string,
) {
	const url = new URL(issuer)
	url.pathname = "/api/platform/organizations"
	const response = await fetch(url, { headers: credentialHeaders(identity.credential) })
	if (!response.ok) throw new Error(`Organization lookup failed: ${response.status}`)
	return z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await response.json()).organizations
}

export async function checkViewerOrganizationMembership(
	identity: AuthIdentity<ViewerCredential>,
	organizationId: string,
	issuer: string,
) {
	const url = new URL(
		`/api/viewer/organizations/${encodeURIComponent(organizationId)}/membership`,
		issuer,
	)
	if (identity.credential.type === "slate-mcp-oauth") {
		url.searchParams.set("resource", identity.credential.resource)
	}
	const response = await fetch(url, { headers: credentialHeaders(identity.credential) })
	if (!response.ok) throw new Error(`Membership lookup failed: ${response.status}`)
	return z.object({ isMember: z.boolean() }).parse(await response.json()).isMember
}

export async function authenticateAccessToken(
	input: ResourceRequestInput,
	issuer: string,
): Promise<AuthIdentity<PlatformOAuthCredential>> {
	const claims = await verifyAccessTokenRequest(input, {
		jwksUrl: `${issuer.replace(/\/$/, "")}/jwks`,
		requiredScopes: [PLATFORM_SCOPE],
		verifyOptions: {
			audience: PLATFORM_RESOURCE,
			issuer,
			requiredClaims: ["sub", "exp", "scope"],
		},
	})
	const token = z
		.string()
		.min(1)
		.parse(parseAccessTokenAuthorization(input.authorizationHeader)?.token)
	return {
		credential: { claims, token, type: "platform-oauth" },
		user: userSchema.parse({ id: claims.sub }),
	}
}

export function authenticateSession<
	C extends WebSessionCredential | ViewerSessionCredential,
>(credential: C, issuer: string): Promise<AuthIdentity<C> | null>
export async function authenticateSession(
	credential: WebSessionCredential | ViewerSessionCredential,
	issuer: string,
) {
	const headers = new Headers()
	switch (credential.type) {
		case "web-session":
			headers.set("Cookie", credential.cookie)
			break
		case "viewer-session":
			headers.set("Authorization", `Bearer ${credential.token}`)
			break
	}
	const response = await fetch(`${issuer.replace(/\/$/, "")}/get-session`, {
		headers,
	})
	if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`)
	const user = sessionSchema.parse(await response.json())?.user
	if (!user) return null
	return { credential, user }
}

export async function findOrganizationBySlug(
	identity: AuthIdentity<PlatformCredential>,
	issuer: string,
	slug: string,
) {
	const organizations = await listOrganizations(identity, issuer)
	return organizations.find((organization) => organization.slug === slug)
}

export async function getCurrentUser(
	identity: AuthIdentity<PlatformCredential>,
	issuer: string,
) {
	const response = await fetch(new URL("/api/me", issuer), {
		headers: credentialHeaders(identity.credential),
	})
	if (!response.ok) throw new Error(`Profile lookup failed: ${response.status}`)
	return userSchema
		.extend({ image: z.string().nullable(), name: z.string() })
		.parse(await response.json())
}
