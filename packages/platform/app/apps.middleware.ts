import { createMiddleware } from "hono/factory"
import { type App, appTargetSchema, resolveAppQuerySchema } from "@/apps.schema"
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

export const requireAppViewing = createMiddleware<ViewingEnv>(async (c, next) => {
	const target = c.req.param("target")
	const input =
		target === undefined
			? resolveAppQuerySchema
					.transform(({ hostname }) => ({ public_hostname: hostname }))
					.safeParse(c.req.query())
			: appTargetSchema.safeParse(target)
	if (!input.success) return c.json({ error: input.error }, 400)
	const result = await resolveAppForViewing(
		c.var.db,
		input.data,
		c.var.identity,
		c.var.config.CTX_AUTH_ISSUER,
	)
	if (!result.allowed) {
		const status = { forbidden: 403, "not-found": 404, "sign-in-required": 401 } as const
		return c.body(null, status[result.reason])
	}
	c.set("appAccess", { app: result.app, identity: result.identity })
	await next()
})
