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

export type SessionCredential =
	| { type: "cookie"; cookie: string }
	| { type: "session"; token: string }

type OAuthCredential = {
	type: "access-token"
	token: string
	claims: JWTPayload
	resource: string
}

export type CredentialAssertion =
	| SessionCredential
	| { type: "access-token"; input: ResourceRequestInput }

export type AuthIdentity = {
	user: z.infer<typeof userSchema>
	credential: OAuthCredential | SessionCredential
}

export type ManagementIdentity = AuthIdentity & {
	credential:
		| Extract<SessionCredential, { type: "cookie" }>
		| (OAuthCredential & { resource: typeof PLATFORM_RESOURCE })
}

export function hasManagementAuthority(
	identity: AuthIdentity,
): identity is ManagementIdentity {
	const credential = identity.credential
	return (
		credential.type === "cookie" ||
		(credential.type === "access-token" &&
			credential.resource === PLATFORM_RESOURCE &&
			typeof credential.claims.scope === "string" &&
			credential.claims.scope.split(" ").includes(PLATFORM_SCOPE))
	)
}

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

export async function listOrganizations(identity: ManagementIdentity, issuer: string) {
	const url = new URL(issuer)
	url.pathname = "/api/platform/organizations"
	const response = await fetch(url, { headers: credentialHeaders(identity.credential) })
	if (!response.ok) throw new Error(`Organization lookup failed: ${response.status}`)
	return z
		.object({ organizations: z.array(organizationSchema) })
		.parse(await response.json()).organizations
}

export async function checkViewerOrganizationMembership(
	identity: AuthIdentity,
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
	input: ResourceRequestInput,
	issuer: string,
): Promise<AuthIdentity> {
	const resource = PLATFORM_RESOURCE
	const claims = await verifyAccessTokenRequest(input, {
		jwksUrl: `${issuer.replace(/\/$/, "")}/jwks`,
		requiredScopes: [PLATFORM_SCOPE],
		verifyOptions: {
			audience: resource,
			issuer,
			requiredClaims: ["sub", "exp", "scope"],
		},
	})
	const token = z
		.string()
		.min(1)
		.parse(parseAccessTokenAuthorization(input.authorizationHeader)?.token)
	return {
		credential: { claims, resource, token, type: "access-token" },
		user: userSchema.parse({ id: claims.sub }),
	}
}

export async function authenticateSession(
	credential: SessionCredential,
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
	return { credential, user }
}

export async function findOrganizationBySlug(
	identity: ManagementIdentity,
	issuer: string,
	slug: string,
) {
	const organizations = await listOrganizations(identity, issuer)
	return organizations.find((organization) => organization.slug === slug)
}

export async function getCurrentUser(identity: ManagementIdentity, issuer: string) {
	const response = await fetch(new URL("/api/me", issuer), {
		headers: credentialHeaders(identity.credential),
	})
	if (!response.ok) throw new Error(`Profile lookup failed: ${response.status}`)
	return userSchema
		.extend({ image: z.string().nullable(), name: z.string() })
		.parse(await response.json())
}
