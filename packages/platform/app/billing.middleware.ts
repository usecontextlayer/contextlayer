import { createMiddleware } from "hono/factory"
import type { ViewingEnv } from "@/apps.middleware"
import { checkAppBilling } from "@/billing.server"

export const requireAppBilling = createMiddleware<ViewingEnv>(async (c, next) => {
	const billing = await checkAppBilling(c.var.db, c.var.config, c.var.appAccess.app)
	if (!billing.allowed) return c.text(billing.message, 402)
	await next()
})
