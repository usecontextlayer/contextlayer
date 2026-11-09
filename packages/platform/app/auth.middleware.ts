import { isAPIError } from "better-auth/api"
import { requestToResourceInput } from "better-auth/oauth2"
import type { Context } from "hono"
import { accepts } from "hono/accepts"
import { except } from "hono/combine"
import { getCookie } from "hono/cookie"
import { csrf } from "hono/csrf"
import { createMiddleware } from "hono/factory"
import type { z } from "zod"
import {
	type AuthIdentity,
	authenticateAccessToken,
	authenticateSession,
	type CredentialAssertion,
	hasManagementAuthority,
	type ManagementIdentity,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"
import { authenticateMcpRequest } from "@/mcp.server"
import type { resolveSlateQuerySchema } from "@/slates.schema"

export type IdentityEnv = PlatformEnv & { Variables: { identity: AuthIdentity | null } }
export type ManagementIdentityEnv = IdentityEnv & {
	Variables: { identity: ManagementIdentity | null }
}
export type AuthenticatedEnv = IdentityEnv & {
	Variables: { identity: AuthIdentity }
}
export type ManagementAuthenticatedEnv = AuthenticatedEnv & {
	Variables: { identity: ManagementIdentity }
}

function createRequireAuth({ signInRedirect = false } = {}) {
	return createMiddleware<AuthenticatedEnv>(async (c, next) => {
		if (!c.var.identity) {
			if (
				signInRedirect &&
				c.req.method === "GET" &&
				accepts(c, {
					default: "application/json",
					header: "Accept",
					supports: ["application/json", "text/html"],
				}) === "text/html"
			) {
				const signIn = new URL("/auth/sign-in", c.var.config.CTX_AUTH_ISSUER)
				signIn.searchParams.set("redirectTo", c.req.url)
				return c.redirect(signIn.href)
			}
			c.header("WWW-Authenticate", 'Bearer realm="ContextLayer"')
			return c.body(null, 401)
		}
		await next()
	})
}

export const requireAuth = createRequireAuth()
export const requireDashboardAuth = createRequireAuth({ signInRedirect: true })

export const requireCsrf = except(
	(c: Context<IdentityEnv>) =>
		!c.var.identity || c.var.identity.credential.type === "access-token",
	csrf(),
)

function getRequestCredential<E extends IdentityEnv>(
	c: Context<E>,
	{ viewerCookie }: { viewerCookie: boolean },
): CredentialAssertion | null {
	if (c.req.header("authorization") !== undefined) {
		return { input: requestToResourceInput(c.req.raw), type: "access-token" }
	}
	const session = viewerCookie ? getCookie(c, "ctx-viewer-auth") : undefined
	if (session) return { token: session, type: "session" }
	const cookie = c.req.header("cookie")
	return cookie ? { cookie, type: "cookie" } : null
}

async function getRequestIdentity<E extends IdentityEnv>(
	c: Context<E>,
	options: { viewerCookie: boolean },
) {
	const credential = getRequestCredential(c, options)
	if (!credential) return null
	if (credential.type !== "access-token") {
		return authenticateSession(credential, c.var.config.CTX_AUTH_ISSUER)
	}
	try {
		return await authenticateAccessToken(credential.input, c.var.config.CTX_AUTH_ISSUER)
	} catch (error) {
		if (isAPIError(error) && [401, 403].includes(error.statusCode)) return null
		throw error
	}
}

export const identifyUser = createMiddleware<ManagementIdentityEnv>(async (c, next) => {
	const identity = await getRequestIdentity(c, { viewerCookie: false })
	c.set("identity", identity && hasManagementAuthority(identity) ? identity : null)
	await next()
})

export async function getSlateViewerIdentity<E extends IdentityEnv>(
	c: Context<E>,
	input: z.infer<typeof resolveSlateQuerySchema>,
) {
	if (input.pathname !== "/mcp") return getRequestIdentity(c, { viewerCookie: true })
	return authenticateMcpRequest(
		requestToResourceInput(c.req.raw),
		input.hostname,
		c.var.config.CTX_AUTH_ISSUER,
	)
}
