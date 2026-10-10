import { createMiddleware } from "hono/factory"
import type {
	AuthenticatedEnv,
	IdentityEnv,
	OwnerAuthenticatedEnv,
} from "@/auth.middleware"
import type { AuthIdentity } from "@/auth.server"
import { type Slate, slateTargetSchema } from "@/slates.schema"
import {
	type OwnerSlateAccess,
	resolveSlateForViewing,
	type SlateAccess,
} from "@/slates.server"

export type ViewingEnv = IdentityEnv & {
	Variables: { slateAccess: { slate: Slate; identity: AuthIdentity | null } }
}
export type AuthenticatedViewingEnv = ViewingEnv &
	AuthenticatedEnv & {
		Variables: { slateAccess: SlateAccess }
	}

export type OwnerViewingEnv = AuthenticatedViewingEnv &
	OwnerAuthenticatedEnv & {
		Variables: { slateAccess: OwnerSlateAccess }
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
