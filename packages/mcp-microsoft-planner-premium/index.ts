// Stateless OAuth pass-through for Composio's DCR_OAUTH flow. Microsoft owns
// consent, codes and tokens; Composio owns the callback and credential storage.
// Registration returns the configured Entra client, never its secret.
import {
	type AuthorizationServerMetadata,
	createMcpHandler,
	getOAuthProtectedResourceMetadataUrl,
	OAuthError,
	OAuthErrorCode,
	type OAuthTokenVerifier,
	oauthMetadataResponse,
	requireBearerAuth,
} from "@modelcontextprotocol/server"
import { htmlPage } from "@usecontextlayer/sdk/html"
import { Hono } from "hono"
import { html } from "hono/html"
import { decodeJwt, errors } from "jose"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"
import { createScheduleApiClient } from "@/lib/schedule-api"
import { createMcpServer } from "@/lib/server"

const app = new Hono<{ Bindings: Bindings }>()

const orgParameter = "ctx_dataverse_org_url"
const dataverseOrgUrl = z
	.url({
		hostname: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.crm\d*\.dynamics\.com$/,
		protocol: /^https$/,
	})
	.transform((value) => new URL(value))
	.refine(
		(url) =>
			url.username === "" &&
			url.password === "" &&
			url.port === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "",
		"Expected a Dataverse environment HTTPS origin",
	)

const dataverseTokenClaims = z.object({
	appid: z.string(),
	aud: dataverseOrgUrl,
	exp: z.number(),
	scp: z.string(),
})

// These are claim checks only. Dataverse validates the forwarded credential;
// decoding a JWT here does not verify Microsoft's signature.
const verifier: OAuthTokenVerifier = {
	async verifyAccessToken(token) {
		try {
			const claims = dataverseTokenClaims.parse(decodeJwt(token))
			return {
				clientId: claims.appid,
				expiresAt: claims.exp,
				resource: claims.aud,
				scopes: claims.scp.split(" "),
				token,
			}
		} catch (error) {
			if (error instanceof errors.JWTInvalid || error instanceof z.ZodError) {
				throw new OAuthError(
					OAuthErrorCode.InvalidToken,
					"Invalid Dataverse access token",
				)
			}
			throw error
		}
	},
}

app.use("/.well-known/*", async (c, next) => {
	const origin = new URL(c.req.url).origin
	const oauthMetadata = {
		authorization_endpoint: `${origin}/authorize`,
		code_challenge_methods_supported: ["S256"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		issuer: origin,
		registration_endpoint: `${origin}/register`,
		response_types_supported: ["code"],
		token_endpoint: `${origin}/token`,
		token_endpoint_auth_methods_supported: ["none"],
	} satisfies AuthorizationServerMetadata
	return (
		oauthMetadataResponse(c.req.raw, {
			oauthMetadata,
			resourceServerUrl: new URL("/mcp", origin),
		}) ?? next()
	)
})

app.post("/register", async (c) => {
	const env = parseEnv(c.env)
	const { redirect_uris } = z
		.object({ redirect_uris: z.array(z.url()) })
		.parse(await c.req.json())
	return c.json(
		{
			client_id: env.CTX_ENTRA_CLIENT_ID,
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris,
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		},
		201,
	)
})

app.get("/authorize", (c) => {
	const query = new URL(c.req.url).searchParams
	const org = query.get(orgParameter)
	query.delete(orgParameter)
	const parsed = dataverseOrgUrl.safeParse(org)
	if (!parsed.success) {
		const invalid = org !== null
		return c.html(
			htmlPage({
				children: html`
					<header class="text-center mb-8">
						<h1 class="h3 fw-semibold mb-4">Connect Planner Premium</h1>
						<p class="fg-2 mb-0">Choose the Dataverse environment you want to connect.</p>
					</header>
					<form action="/authorize" method="get">
						${[...query].map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}
						<div class="form-field mb-6">
							<label for="org" class="form-label">Dataverse environment URL</label>
							<input id="org" type="url" name="${orgParameter}" class="form-control${invalid ? " is-invalid" : ""}" value="${org ?? ""}" aria-invalid="${invalid ? "true" : "false"}" aria-describedby="${invalid ? "org-error" : ""}" placeholder="https://your-org.crm.dynamics.com" required>
							${invalid ? html`<div id="org-error" class="invalid-feedback" role="alert">Enter a Dataverse environment URL like https://your-org.crm.dynamics.com.</div>` : ""}
						</div>
						<button type="submit" class="btn-solid theme-inverse w-100">Continue to Microsoft</button>
					</form>`,
				title: "Connect Planner Premium",
			}),
			invalid ? 400 : 200,
		)
	}

	const destination = new URL(
		"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
	)
	destination.search = query.toString()
	// RFC 8707 `resource` names this MCP server; Microsoft v2 targets its resource
	// through `scope` alone and rejects a request carrying both (AADSTS9010010).
	destination.searchParams.delete("resource")
	destination.searchParams.set(
		"scope",
		`${parsed.data.origin}/user_impersonation offline_access`,
	)
	return c.redirect(destination.href, 302)
})

app.post("/token", async (c) => {
	const env = parseEnv(c.env)
	const body = new URLSearchParams(await c.req.text())
	z.enum(["authorization_code", "refresh_token"]).parse(body.get("grant_type"))
	body.delete("resource")
	body.set("client_id", env.CTX_ENTRA_CLIENT_ID)
	body.set("client_secret", env.CTX_ENTRA_CLIENT_SECRET)
	return fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
		body,
		method: "POST",
	})
})

app.all("/mcp", async (c) => {
	const gate = requireBearerAuth({
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL("/mcp", c.req.url)),
		verifier,
	})
	const authInfo = await gate(c.req.raw)
	if (authInfo instanceof Response) return authInfo

	const api = createScheduleApiClient({
		accessToken: authInfo.token,
		orgUrl: (authInfo.resource as URL).origin,
	})
	const handler = createMcpHandler(() => createMcpServer(api))
	return handler.fetch(c.req.raw, { authInfo })
})

export default app
