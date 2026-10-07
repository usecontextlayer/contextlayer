import { createMiddleware } from "hono/factory"
import type { ViewingEnv } from "@/apps.middleware"
import { checkAppSubscription } from "@/billing.server"

export const requireAppSubscription = createMiddleware<ViewingEnv>(async (c, next) => {
	if (!(await checkAppSubscription(c.var.db, c.var.appAccess.app))) {
		return c.body(null, 402)
	}
	await next()
})
