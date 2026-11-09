import type { ResourceServerMetadata } from "@better-auth/oauth-provider"
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { createAuthClient } from "better-auth/client"
import {
	parseAccessTokenAuthorization,
	type ResourceRequestInput,
} from "better-auth/oauth2"
import { z } from "zod"
import { type AuthIdentity, userSchema } from "@/auth.server"

const resourceClient = createAuthClient({ plugins: [oauthProviderResourceClient()] })
const MCP_SCOPE = "mcp:access"

export function mcpResource(hostname: string) {
	return new URL("/mcp", `https://${hostname}`).href
}

export function getMcpMetadata(
	hostname: string,
	issuer: string,
): Promise<ResourceServerMetadata> {
	return resourceClient.getProtectedResourceMetadata(
		{
			authorization_servers: [issuer],
			bearer_methods_supported: ["header"],
			resource: mcpResource(hostname),
			scopes_supported: [MCP_SCOPE],
		},
		{ externalScopes: [MCP_SCOPE] },
	)
}

export async function authenticateMcpRequest(
	input: ResourceRequestInput,
	hostname: string,
	issuer: string,
): Promise<AuthIdentity> {
	const resource = mcpResource(hostname)
	const claims = await resourceClient.verifyAccessTokenRequest(input, {
		jwksUrl: `${issuer.replace(/\/$/, "")}/jwks`,
		requiredScopes: [MCP_SCOPE],
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
