import { OpenAPIHono, z } from "@hono/zod-openapi"
import { createAgentsApi } from "@/agents.api"
import { identifyUser, requireAuth, requireCsrf } from "@/auth.middleware"
import { platformContext } from "@/platform.middleware"
import { type ManagementViewingEnv, slateViewingErrorStatus } from "@/slates.middleware"
import { resolveSlateForViewing } from "@/slates.server"

export function createSlateApi() {
	const api = new OpenAPIHono<ManagementViewingEnv>()
	api.use("*", platformContext, identifyUser, requireCsrf, requireAuth)
	api.use("*", async (c, next) => {
		const access = await resolveSlateForViewing(
			c.var.db,
			{ public_hostname: new URL(c.req.url).hostname },
			c.var.identity,
			c.var.config.CTX_AUTH_ISSUER,
		)
		if (!access.allowed) return c.body(null, slateViewingErrorStatus[access.reason])
		c.set("slateAccess", { identity: c.var.identity, slate: access.slate })
		await next()
	})
	api.route("/.ctx/agents/:name", createAgentsApi(z.object({})))
	return api
}
