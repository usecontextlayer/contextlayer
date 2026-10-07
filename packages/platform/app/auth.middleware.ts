import type { Context } from "hono"
import { accepts } from "hono/accepts"
import { except } from "hono/combine"
import { getCookie } from "hono/cookie"
import { csrf } from "hono/csrf"
import { createMiddleware } from "hono/factory"
import { errors } from "jose"
import { z } from "zod"
import type { resolveAppQuerySchema } from "@/apps.schema"
import {
	type AuthIdentity,
	authenticateAccessToken,
	authenticateSession,
	type NativeAuthIdentity,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"
import { authenticateMcpRequest } from "@/mcp.server"

export type IdentityEnv = PlatformEnv & { Variables: { identity: AuthIdentity | null } }
export type AuthenticatedEnv = IdentityEnv & {
	Variables: { identity: AuthIdentity }
}
export type NativeAuthenticatedEnv = AuthenticatedEnv & {
	Variables: { identity: NativeAuthIdentity }
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

async function getRequestIdentity(
	c: Context<IdentityEnv>,
	{ viewerCookie }: { viewerCookie: boolean },
) {
	const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1]
	const session = viewerCookie ? getCookie(c, "ctx-viewer-auth") : undefined
	const cookie = c.req.header("cookie")
	const credential = token
		? ({ token, type: "access-token" } as const)
		: session
			? ({ token: session, type: "session" } as const)
			: cookie
				? ({ cookie, type: "cookie" } as const)
				: null
	let user = null
	if (credential?.type === "access-token") {
		try {
			user = await authenticateAccessToken(credential.token, c.var.config.CTX_AUTH_ISSUER)
		} catch (error) {
			if (!(error instanceof errors.JOSEError || error instanceof z.ZodError)) throw error
		}
	} else if (credential) {
		user = await authenticateSession(credential, c.var.config.CTX_AUTH_ISSUER)
	}
	return user && credential ? { credential, user } : null
}

function createIdentifyUser({ viewerCookie = false } = {}) {
	return createMiddleware<IdentityEnv>(async (c, next) => {
		c.set("identity", await getRequestIdentity(c, { viewerCookie }))
		await next()
	})
}

export const identifyUser = createIdentifyUser()
export const identifyViewer = createIdentifyUser({ viewerCookie: true })

export async function getAppViewerIdentity(
	c: Context<IdentityEnv>,
	input: z.infer<typeof resolveAppQuerySchema>,
) {
	if (input.pathname !== "/mcp") return getRequestIdentity(c, { viewerCookie: true })
	const user = await authenticateMcpRequest(
		c.req.raw,
		input.hostname,
		c.var.config.CTX_AUTH_ISSUER,
	)
	const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1]
	return {
		credential: { token: z.string().min(1).parse(token), type: "access-token" as const },
		user,
	}
}
