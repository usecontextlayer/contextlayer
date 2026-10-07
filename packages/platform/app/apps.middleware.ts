import { createMiddleware } from "hono/factory"
import { type App, appTargetSchema } from "@/apps.schema"
import { type AppAccess, resolveAppForViewing } from "@/apps.server"
import type { AuthenticatedEnv, IdentityEnv } from "@/auth.middleware"
import type { AuthIdentity } from "@/auth.server"

export type ViewingEnv = IdentityEnv & {
	Variables: { appAccess: { app: App; identity: AuthIdentity | null } }
}
export type AuthenticatedViewingEnv = ViewingEnv &
	AuthenticatedEnv & {
		Variables: { appAccess: AppAccess }
	}

export const appViewingErrorStatus = {
	forbidden: 403,
	"not-found": 404,
	"sign-in-required": 401,
} as const

export const requireAppViewing = createMiddleware<ViewingEnv>(async (c, next) => {
	const input = appTargetSchema.safeParse(c.req.param("target"))
	if (!input.success) return c.json({ error: input.error }, 400)
	const result = await resolveAppForViewing(
		c.var.db,
		input.data,
		c.var.identity,
		c.var.config.CTX_AUTH_ISSUER,
	)
	if (!result.allowed) {
		return c.body(null, appViewingErrorStatus[result.reason])
	}
	c.set("appAccess", { app: result.app, identity: result.identity })
	await next()
})
