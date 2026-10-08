import type { ResourceServerMetadata } from "@better-auth/oauth-provider"
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { createAuthClient } from "better-auth/client"
import { userSchema } from "@/auth.server"

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
	request: Request,
	hostname: string,
	issuer: string,
) {
	const claims = await resourceClient.verifyAccessTokenRequest(request, {
		jwksUrl: `${issuer.replace(/\/$/, "")}/jwks`,
		requiredScopes: [MCP_SCOPE],
		verifyOptions: {
			audience: mcpResource(hostname),
			issuer,
			requiredClaims: ["sub", "exp", "scope"],
		},
	})
	return userSchema.parse({ id: claims.sub })
}
