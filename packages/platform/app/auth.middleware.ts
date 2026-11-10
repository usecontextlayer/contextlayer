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
	type Credential,
	hasPlatformCredential,
	type PlatformCredential,
	type PlatformOAuthCredential,
	type ViewerSessionCredential,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"
import { authenticateMcpRequest } from "@/mcp.server"
import type { resolveSlateQuerySchema } from "@/slates.schema"

export type IdentityEnv<C extends Credential = Credential> = PlatformEnv & {
	Variables: { identity: AuthIdentity<C> | null }
}
export type AuthenticatedEnv<C extends Credential = Credential> = IdentityEnv<C> & {
	Variables: { identity: AuthIdentity<C> }
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

export const requireCsrf = except((c: Context<IdentityEnv>) => {
	if (!c.var.identity) return true
	switch (c.var.identity.credential.type) {
		case "web-session":
		case "viewer-session":
			return false
		case "platform-oauth":
		case "slate-mcp-oauth":
			return true
	}
}, csrf())

async function getPlatformBearerIdentity<E extends IdentityEnv>(
	c: Context<E>,
): Promise<AuthIdentity<PlatformOAuthCredential> | null> {
	try {
		return await authenticateAccessToken(
			requestToResourceInput(c.req.raw),
			c.var.config.CTX_AUTH_ISSUER,
		)
	} catch (error) {
		if (isAPIError(error) && [401, 403].includes(error.statusCode)) return null
		throw error
	}
}

async function getPlatformRequestIdentity<E extends IdentityEnv>(
	c: Context<E>,
): Promise<AuthIdentity<PlatformCredential> | null> {
	if (c.req.header("authorization") !== undefined) {
		return getPlatformBearerIdentity(c)
	}
	const cookie = c.req.header("cookie")
	return cookie
		? authenticateSession({ cookie, type: "web-session" }, c.var.config.CTX_AUTH_ISSUER)
		: null
}

export const identifyPlatformUser = createMiddleware<IdentityEnv<PlatformCredential>>(
	async (c, next) => {
		c.set("identity", await getPlatformRequestIdentity(c))
		await next()
	},
)

export const identifySlateUser = createMiddleware<
	IdentityEnv<PlatformOAuthCredential | ViewerSessionCredential>
>(async (c, next) => {
	if (c.req.header("authorization") !== undefined) {
		c.set("identity", await getPlatformBearerIdentity(c))
	} else {
		const token = getCookie(c, "ctx-viewer-auth")
		c.set(
			"identity",
			token
				? await authenticateSession(
						{ token, type: "viewer-session" },
						c.var.config.CTX_AUTH_ISSUER,
					)
				: null,
		)
	}
	await next()
})

export const requirePlatformCredential = createMiddleware<AuthenticatedEnv>(
	async (c, next) => {
		if (!hasPlatformCredential(c.var.identity)) {
			c.header("WWW-Authenticate", 'Bearer realm="ContextLayer"')
			return c.body(null, 401)
		}
		await next()
	},
)

export async function getSlateViewerIdentity<E extends IdentityEnv>(
	c: Context<E>,
	input: z.infer<typeof resolveSlateQuerySchema>,
): Promise<AuthIdentity | null> {
	if (input.pathname === "/mcp") {
		return authenticateMcpRequest(
			requestToResourceInput(c.req.raw),
			input.hostname,
			c.var.config.CTX_AUTH_ISSUER,
		)
	}
	if (c.req.header("authorization") === undefined) {
		const token = getCookie(c, "ctx-viewer-auth")
		if (token) {
			return authenticateSession(
				{ token, type: "viewer-session" },
				c.var.config.CTX_AUTH_ISSUER,
			)
		}
	}
	return getPlatformRequestIdentity(c)
}
