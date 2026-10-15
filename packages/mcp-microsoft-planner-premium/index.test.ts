// The Worker's own OAuth contract, driven through the production Hono app.
// Token exchange and refresh need a real Microsoft sign-in; no token response is
// invented here and none of these tests sends a request outside the app.
import { UnsecuredJWT } from "jose"
import { describe, expect, it } from "vitest"
import type { Bindings } from "@/env"
import app from "@/index"

const bindings = {
	CTX_DATAVERSE_ORG_URL: "https://planner-test.crm.dynamics.com/",
	CTX_ENTRA_CLIENT_ID: "aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11",
	CTX_ENTRA_CLIENT_SECRET: "test-only-secret",
	CTX_ENTRA_TENANT: "organizations",
} satisfies Bindings
const origin = "https://planner.example"

describe("MCP HTTP authentication", () => {
	it("challenges a missing token with reachable resource metadata", async () => {
		const response = await app.request(`${origin}/mcp`, { method: "POST" }, bindings)
		expect(response.status).toBe(401)
		expect(await response.json()).toMatchObject({ error: "invalid_token" })
		const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${metadataUrl}"`,
		)
		const metadata = await app.request(metadataUrl, {}, bindings)
		expect(metadata.status).toBe(200)
		expect(await metadata.json()).toMatchObject({
			authorization_servers: [origin],
			resource: `${origin}/mcp`,
		})
	})

	it.each([
		{
			audience: bindings.CTX_DATAVERSE_ORG_URL,
			expiresAt: 0,
			name: "expired token",
		},
		{
			audience: "https://another-org.crm.dynamics.com",
			expiresAt: "1h",
			name: "token for another org",
		},
	])("rejects $name at the HTTP edge", async ({ audience, expiresAt }) => {
		const token = new UnsecuredJWT({
			appid: bindings.CTX_ENTRA_CLIENT_ID,
			scp: "user_impersonation",
		})
			.setAudience(audience)
			.setExpirationTime(expiresAt)
			.encode()
		const response = await app.request(
			`${origin}/mcp`,
			{ headers: { Authorization: `Bearer ${token}` }, method: "POST" },
			bindings,
		)
		expect(response.status).toBe(401)
		expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"')
		expect(await response.json()).toMatchObject({ error: "invalid_token" })
	})
})

describe("Composio DCR OAuth", () => {
	it("advertises the Worker endpoints and delegated Dataverse scopes", async () => {
		const response = await app.request(
			`${origin}/.well-known/oauth-authorization-server`,
			{},
			bindings,
		)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toContain("application/json")
		expect(await response.json()).toEqual({
			authorization_endpoint: `${origin}/authorize`,
			code_challenge_methods_supported: ["S256"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			issuer: origin,
			registration_endpoint: `${origin}/register`,
			response_types_supported: ["code"],
			scopes_supported: [
				"https://planner-test.crm.dynamics.com/user_impersonation",
				"offline_access",
			],
			token_endpoint: `${origin}/token`,
			token_endpoint_auth_methods_supported: ["none"],
		})
	})

	it("registers the fixed Entra client with the caller's redirect URIs and no secret", async () => {
		const redirect_uris = [
			"https://connect.example/oauth/callback?return_to=%2Fmcp",
			"https://connect.example/oauth/another-callback",
		]
		const response = await app.request(
			`${origin}/register`,
			{
				body: JSON.stringify({ client_name: "Composio", redirect_uris }),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			},
			bindings,
		)
		expect(response.status).toBe(201)
		expect(await response.json()).toEqual({
			client_id: bindings.CTX_ENTRA_CLIENT_ID,
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris,
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		})
	})

	it("redirects to Microsoft with the callback, state and PKCE unchanged", async () => {
		const query = new URLSearchParams({
			client_id: bindings.CTX_ENTRA_CLIENT_ID,
			code_challenge: "a-PKCE_challenge.with~characters",
			code_challenge_method: "S256",
			redirect_uri: "https://connect.example/oauth/callback?next=%2Fmcp&from=planner",
			response_type: "code",
			scope: "mcp",
			state: "state with + / & = % characters",
		})
		const response = await app.request(`${origin}/authorize?${query}`, {}, bindings)
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get("Location") as string)
		expect(`${location.origin}${location.pathname}`).toBe(
			"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
		)
		expect(Object.fromEntries(location.searchParams)).toEqual({
			...Object.fromEntries(query),
			scope: "https://planner-test.crm.dynamics.com/user_impersonation offline_access",
		})
	})
})
