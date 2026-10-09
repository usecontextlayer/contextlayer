import { isAPIError } from "better-auth/api"
import type { Context } from "hono"
import { accepts } from "hono/accepts"
import { except } from "hono/combine"
import { getCookie } from "hono/cookie"
import { csrf } from "hono/csrf"
import { createMiddleware } from "hono/factory"
import type { z } from "zod"
import type { resolveAppQuerySchema } from "@/apps.schema"
import {
	type AuthIdentity,
	authenticateAccessToken,
	authenticateSession,
	type OwnerIdentity,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"
import { authenticateMcpRequest } from "@/mcp.server"

export type IdentityEnv = PlatformEnv & { Variables: { identity: AuthIdentity | null } }
export type OwnerIdentityEnv = IdentityEnv & {
	Variables: { identity: OwnerIdentity | null }
}
export type AuthenticatedEnv = IdentityEnv & {
	Variables: { identity: AuthIdentity }
}
export type OwnerAuthenticatedEnv = AuthenticatedEnv & {
	Variables: { identity: OwnerIdentity }
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

async function getRequestIdentity<E extends IdentityEnv>(
	c: Context<E>,
	{ viewerCookie }: { viewerCookie: boolean },
) {
	const session = viewerCookie ? getCookie(c, "ctx-viewer-auth") : undefined
	const cookie = c.req.header("cookie")
	if (c.req.header("authorization") !== undefined) {
		try {
			return await authenticateAccessToken(c.req.raw, c.var.config.CTX_AUTH_ISSUER)
		} catch (error) {
			if (isAPIError(error) && [401, 403].includes(error.statusCode)) return null
			throw error
		}
	}
	const credential = session
		? ({ token: session, type: "session" } as const)
		: cookie
			? ({ cookie, type: "cookie" } as const)
			: null
	return credential ? authenticateSession(credential, c.var.config.CTX_AUTH_ISSUER) : null
}

export const identifyUser = createMiddleware<IdentityEnv>(async (c, next) => {
	c.set("identity", await getRequestIdentity(c, { viewerCookie: false }))
	await next()
})

export async function getAppViewerIdentity<E extends IdentityEnv>(
	c: Context<E>,
	input: z.infer<typeof resolveAppQuerySchema>,
) {
	if (input.pathname !== "/mcp") return getRequestIdentity(c, { viewerCookie: true })
	return authenticateMcpRequest(c.req.raw, input.hostname, c.var.config.CTX_AUTH_ISSUER)
}
