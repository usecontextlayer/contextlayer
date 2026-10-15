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
import { Hono } from "hono"
import { decodeJwt, errors } from "jose"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"
import { createScheduleApiClient } from "@/lib/schedule-api"
import { createMcpServer } from "@/lib/server"

const app = new Hono<{ Bindings: Bindings }>()

const dataverseTokenClaims = z.object({
	appid: z.string(),
	aud: z.url().transform((value) => new URL(value)),
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
	const env = parseEnv(c.env)
	const origin = new URL(c.req.url).origin
	const oauthMetadata = {
		authorization_endpoint: `${origin}/authorize`,
		code_challenge_methods_supported: ["S256"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		issuer: origin,
		registration_endpoint: `${origin}/register`,
		response_types_supported: ["code"],
		scopes_supported: [
			`${env.CTX_DATAVERSE_ORG_URL}/user_impersonation`,
			"offline_access",
		],
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
	const env = parseEnv(c.env)
	const destination = new URL(
		`https://login.microsoftonline.com/${env.CTX_ENTRA_TENANT}/oauth2/v2.0/authorize`,
	)
	destination.search = new URL(c.req.url).search
	destination.searchParams.set(
		"scope",
		`${env.CTX_DATAVERSE_ORG_URL}/user_impersonation offline_access`,
	)
	return c.redirect(destination.href, 302)
})

app.post("/token", async (c) => {
	const env = parseEnv(c.env)
	const body = new URLSearchParams(await c.req.text())
	z.enum(["authorization_code", "refresh_token"]).parse(body.get("grant_type"))
	body.set("client_id", env.CTX_ENTRA_CLIENT_ID)
	body.set("client_secret", env.CTX_ENTRA_CLIENT_SECRET)
	return fetch(
		`https://login.microsoftonline.com/${env.CTX_ENTRA_TENANT}/oauth2/v2.0/token`,
		{ body, method: "POST" },
	)
})

app.all("/mcp", async (c) => {
	const env = parseEnv(c.env)
	const gate = requireBearerAuth({
		expectedResource: new URL(env.CTX_DATAVERSE_ORG_URL),
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL("/mcp", c.req.url)),
		verifier,
	})
	const authInfo = await gate(c.req.raw)
	if (authInfo instanceof Response) return authInfo

	const api = createScheduleApiClient({
		accessToken: authInfo.token,
		orgUrl: env.CTX_DATAVERSE_ORG_URL,
	})
	const handler = createMcpHandler(() => createMcpServer(api))
	return handler.fetch(c.req.raw, { authInfo })
})

export default app
