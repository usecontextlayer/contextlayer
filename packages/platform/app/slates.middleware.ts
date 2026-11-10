import { createMiddleware } from "hono/factory"
import type { AuthenticatedEnv, IdentityEnv } from "@/auth.middleware"
import type { AuthIdentity, Credential } from "@/auth.server"
import { type Slate, slateTargetSchema } from "@/slates.schema"
import { resolveSlateForViewing, type SlateAccess } from "@/slates.server"

export type ViewingEnv<C extends Credential = Credential> = IdentityEnv<C> & {
	Variables: { slateAccess: { slate: Slate; identity: AuthIdentity<C> | null } }
}

export type AuthenticatedViewingEnv<C extends Credential = Credential> = ViewingEnv<C> &
	AuthenticatedEnv<C> & {
		Variables: { slateAccess: SlateAccess<C> }
	}

export const slateViewingErrorStatus = {
	forbidden: 403,
	"not-found": 404,
	"sign-in-required": 401,
} as const

export const requireSlateViewing = createMiddleware<ViewingEnv>(async (c, next) => {
	const input = slateTargetSchema.safeParse(c.req.param("target"))
	if (!input.success) return c.json({ error: input.error }, 400)
	const result = await resolveSlateForViewing(
		c.var.db,
		input.data,
		c.var.identity,
		c.var.config.CTX_AUTH_ISSUER,
	)
	if (!result.allowed) {
		return c.body(null, slateViewingErrorStatus[result.reason])
	}
	c.set("slateAccess", { identity: result.identity, slate: result.slate })
	await next()
})
