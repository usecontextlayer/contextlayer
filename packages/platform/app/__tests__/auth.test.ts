import { expect, test } from "vitest"
import { type AuthIdentity, hasManagementAuthority } from "@/auth.server"

test.each<{
	name: string
	credential: AuthIdentity["credential"]
	allowed: boolean
}>([
	{
		allowed: true,
		credential: { cookie: "native-web-session", type: "cookie" },
		name: "native web session",
	},
	{
		allowed: false,
		credential: { token: "viewer-session", type: "session" },
		name: "viewer session",
	},
	{
		allowed: true,
		credential: {
			claims: { scope: "openid platform:access", sub: "alice" },
			resource: "https://platform.usecontextlayer.com",
			token: "platform-access-token",
			type: "access-token",
		},
		name: "platform access token",
	},
	{
		allowed: false,
		credential: {
			claims: { scope: "openid mcp:access platform:access", sub: "alice" },
			resource: "https://brief.contextlayer.xyz/mcp",
			token: "mcp-access-token",
			type: "access-token",
		},
		name: "slate MCP token carrying platform access scope",
	},
	{
		allowed: false,
		credential: {
			claims: { scope: "openid", sub: "alice" },
			resource: "https://platform.usecontextlayer.com",
			token: "access-token-without-platform-scope",
			type: "access-token",
		},
		name: "platform token without platform access scope",
	},
])("$name grants management authority=$allowed", ({ allowed, credential }) => {
	expect(hasManagementAuthority({ credential, user: { id: "alice" } })).toBe(allowed)
})
