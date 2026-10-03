import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import { errors } from "jose"
import { z } from "zod"
import {
	type AuthIdentity,
	authenticateAccessToken,
	authenticateSession,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"

export type IdentityEnv = PlatformEnv & { Variables: { identity: AuthIdentity | null } }
export type AuthenticatedEnv = IdentityEnv & {
	Variables: { identity: AuthIdentity }
}

export const requireAuth = createMiddleware<AuthenticatedEnv>(async (c, next) => {
	const identity = c.var.identity
	if (!identity) {
		c.header("WWW-Authenticate", 'Bearer realm="ContextLayer"')
		return c.body(null, 401)
	}
	await next()
})

export const identifyUser = createMiddleware<IdentityEnv>(async (c, next) => {
	const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1]
	const session = getCookie(c, "__Secure-ctx_viewer")
	const credential = token
		? ({ token, type: "access-token" } as const)
		: session
			? ({ token: session, type: "session" } as const)
			: null
	let user = null
	if (credential?.type === "access-token") {
		try {
			user = await authenticateAccessToken(credential.token, c.var.config.CTX_AUTH_ISSUER)
		} catch (error) {
			if (!(error instanceof errors.JOSEError || error instanceof z.ZodError)) throw error
		}
	} else if (credential) {
		user = await authenticateSession(credential.token, c.var.config.CTX_AUTH_ISSUER)
	}
	c.set("identity", user && credential ? { credential, user } : null)
	await next()
})
