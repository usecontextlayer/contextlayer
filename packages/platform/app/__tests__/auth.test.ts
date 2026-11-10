import { expect, test } from "vitest"
import { type AuthIdentity, hasPlatformCredential } from "@/auth.server"

test.each<{
	name: string
	identity: AuthIdentity
	allowed: boolean
}>([
	{
		allowed: true,
		identity: {
			credential: { cookie: "native-web-session", type: "web-session" },
			user: { id: "alice" },
		},
		name: "native web session",
	},
	{
		allowed: false,
		identity: {
			credential: { token: "viewer-session", type: "viewer-session" },
			user: { id: "alice" },
		},
		name: "viewer session",
	},
	{
		allowed: true,
		identity: {
			credential: {
				claims: { scope: "openid platform:access", sub: "alice" },
				token: "platform-access-token",
				type: "platform-oauth",
			},
			user: { id: "alice" },
		},
		name: "platform access token",
	},
	{
		allowed: false,
		identity: {
			credential: {
				claims: { scope: "openid mcp:access", sub: "alice" },
				resource: "https://brief.contextlayer.xyz/mcp",
				token: "mcp-access-token",
				type: "slate-mcp-oauth",
			},
			user: { id: "alice" },
		},
		name: "slate MCP token",
	},
])("$name is a platform credential=$allowed", ({ allowed, identity }) => {
	expect(hasPlatformCredential(identity)).toBe(allowed)
})
