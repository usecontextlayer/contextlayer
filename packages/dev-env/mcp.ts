import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { createAuthClient } from "better-auth/client"
import * as oauth from "openid-client"

export async function authorizeMcp({
	clientId,
	issuer,
	redirectUri,
	resource,
	webHeaders,
}: {
	clientId: string
	issuer: string
	redirectUri: string
	resource: string
	webHeaders: Headers
}) {
	const issuerURL = new URL(issuer)
	const config = await oauth.discovery(issuerURL, clientId, undefined, oauth.None(), {
		algorithm: "oauth2",
		execute:
			issuerURL.protocol === "http:" &&
			["localhost", "127.0.0.1"].includes(issuerURL.hostname)
				? [oauth.allowInsecureRequests]
				: [],
	})
	const verifier = oauth.randomPKCECodeVerifier()
	const state = oauth.randomState()
	const authorizationURL = oauth.buildAuthorizationUrl(config, {
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		prompt: "consent",
		redirect_uri: redirectUri,
		resource,
		scope: "mcp:access",
		state,
	})
	const client = createAuthClient({
		baseURL: issuer,
		fetchOptions: { headers: webHeaders, throw: true },
		plugins: [oauthProviderClient()],
	})
	const authorization = await client.oauth2.authorize({
		query: Object.fromEntries(authorizationURL.searchParams),
	})
	const consentURL = new URL(authorization.url, issuer)
	const consent = await client.oauth2.consent({
		accept: true,
		oauth_query: consentURL.searchParams.toString(),
	})
	const tokens = await oauth.authorizationCodeGrant(
		config,
		new URL(consent.url),
		{ expectedState: state, pkceCodeVerifier: verifier },
		{ resource },
	)
	return new Headers({ authorization: `Bearer ${tokens.access_token}` })
}
