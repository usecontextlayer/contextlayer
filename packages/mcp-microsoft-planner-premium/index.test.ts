// The Worker's own OAuth contract, driven through the production Hono app.
// Token exchange and refresh need a real Microsoft sign-in; no token response is
// invented here and none of these tests sends a request outside the app.
import { UnsecuredJWT } from "jose"
import { describe, expect, it } from "vitest"
import type { Bindings } from "@/env"
import app from "@/index"

const bindings = {
	MICROSOFT_CLIENT_ID: "aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11",
	MICROSOFT_CLIENT_SECRET: "test-only-secret",
} satisfies Bindings
const origin = "https://planner.example"
const orgUrl = "https://planner-test.crm.dynamics.com"
const invalidOrgs = [
	"https://graph.microsoft.com",
	"https://planner-test.crm.dynamics.com.evil.example",
	"http://planner-test.crm.dynamics.com",
	"https://planner-test.crm.dynamics.com:8443",
	"https://user:password@planner-test.crm.dynamics.com",
	"https://planner-test.crm.dynamics.com/api/data/v9.2",
	"https://planner-test.crm.dynamics.com?query=value",
	"https://planner-test.crm.dynamics.com#fragment",
]
const authorizationQuery = () =>
	new URLSearchParams({
		client_id: bindings.MICROSOFT_CLIENT_ID,
		code_challenge: "a-PKCE_challenge.with~characters",
		code_challenge_method: "S256",
		prompt: "select_account",
		redirect_uri: "https://connect.example/oauth/callback?next=%2Fmcp&from=planner",
		resource: `${origin}/mcp`,
		response_type: "code",
		scope: "mcp",
		state: 'state with + / & = % " < characters',
	})

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

	it("rejects a malformed token with the SDK challenge", async () => {
		const response = await app.request(
			`${origin}/mcp`,
			{ headers: { Authorization: "Bearer not-a-jwt" }, method: "POST" },
			bindings,
		)
		expect(response.status).toBe(401)
		expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"')
		expect(await response.json()).toMatchObject({ error: "invalid_token" })
	})

	it.each([
		{ audience: orgUrl, expiresAt: 0 },
		...invalidOrgs.map((audience) => ({ audience, expiresAt: "1h" })),
	])(
		"rejects invalid audience or expiry: $audience / $expiresAt",
		async ({ audience, expiresAt }) => {
			const token = new UnsecuredJWT({
				appid: bindings.MICROSOFT_CLIENT_ID,
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
		},
	)
})

describe("removed design-time forwarder", () => {
	it("has no Dataverse forwarding route", async () => {
		const token = new UnsecuredJWT({
			appid: bindings.MICROSOFT_CLIENT_ID,
			scp: "user_impersonation",
		})
			.setAudience(orgUrl)
			.setExpirationTime("1h")
			.encode()
		const response = await app.request(
			`${origin}/dataverse/api/data/v9.2/msdyn_projects`,
			{ headers: { Authorization: `Bearer ${token}` } },
			bindings,
		)
		expect(response.status).toBe(404)
	})
})

describe("Composio DCR OAuth", () => {
	it("advertises org-independent Worker endpoints", async () => {
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
			client_id: bindings.MICROSOFT_CLIENT_ID,
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris,
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		})
	})

	it("asks for the org and carries the OAuth parameters in the form", async () => {
		const response = await app.request(
			`${origin}/authorize?${authorizationQuery()}`,
			{},
			bindings,
		)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toContain("text/html")
		const page = await response.text()
		expect(page).toContain('<form action="/authorize" method="get">')
		expect(page).toContain('type="url" name="ctx_dataverse_org_url"')
		expect(page).toContain("Dataverse environment URL")
		expect(page).toContain(
			'name="state" value="state with + / &amp; = % &quot; &lt; characters"',
		)
		expect(page).toContain(
			'name="redirect_uri" value="https://connect.example/oauth/callback?next=%2Fmcp&amp;from=planner"',
		)
		expect(page).toContain(
			'name="code_challenge" value="a-PKCE_challenge.with~characters"',
		)
	})

	it.each([orgUrl, "https://another-org.crm3.dynamics.com/"])(
		"redirects for %s with the callback, state and PKCE unchanged",
		async (org) => {
			const query = authorizationQuery()
			query.set("ctx_dataverse_org_url", org)
			const response = await app.request(`${origin}/authorize?${query}`, {}, bindings)
			expect(response.status).toBe(302)
			const location = new URL(response.headers.get("Location") as string)
			expect(`${location.origin}${location.pathname}`).toBe(
				"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
			)
			query.delete("ctx_dataverse_org_url")
			query.delete("resource")
			expect(Object.fromEntries(location.searchParams)).toEqual({
				...Object.fromEntries(query),
				scope: `${new URL(org).origin}/user_impersonation offline_access`,
			})
		},
	)

	it.each(invalidOrgs)(
		"keeps an invalid org in the form for correction: %s",
		async (org) => {
			const query = authorizationQuery()
			query.set("ctx_dataverse_org_url", org)
			const response = await app.request(`${origin}/authorize?${query}`, {}, bindings)
			expect(response.status).toBe(400)
			expect(response.headers.get("Location")).toBeNull()
			expect(response.headers.get("content-type")).toContain("text/html")
			const page = await response.text()
			expect(page).toContain('<form action="/authorize" method="get">')
			expect(page).toContain(`value="${org}"`)
			expect(page).toContain('aria-invalid="true"')
			expect(page).toContain('id="org-error"')
			expect(page).toContain("Enter a Dataverse environment URL like")
			expect(page.match(/name="ctx_dataverse_org_url"/g)).toHaveLength(1)
			expect(page).toContain(
				'name="state" value="state with + / &amp; = % &quot; &lt; characters"',
			)
			expect(page).toContain(
				'name="redirect_uri" value="https://connect.example/oauth/callback?next=%2Fmcp&amp;from=planner"',
			)
			expect(page).toContain(
				'name="code_challenge" value="a-PKCE_challenge.with~characters"',
			)
		},
	)
})
