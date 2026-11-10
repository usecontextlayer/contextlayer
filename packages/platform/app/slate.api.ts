import { OpenAPIHono, z } from "@hono/zod-openapi"
import { createAgentsApi } from "@/agents.api"
import { identifySlateUser, requireAuth, requireCsrf } from "@/auth.middleware"
import type { PlatformOAuthCredential, ViewerSessionCredential } from "@/auth.server"
import { platformContext } from "@/platform.middleware"
import {
	type AuthenticatedViewingEnv,
	slateViewingErrorStatus,
} from "@/slates.middleware"
import { resolveSlateForViewing } from "@/slates.server"

export function createSlateApi() {
	const api = new OpenAPIHono<
		AuthenticatedViewingEnv<PlatformOAuthCredential | ViewerSessionCredential>
	>()
	api.use("*", platformContext, identifySlateUser, requireCsrf, requireAuth)
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
