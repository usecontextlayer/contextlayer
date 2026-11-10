import { except } from "hono/combine"
import { RouterContextProvider } from "react-router"
import { createHonoServer } from "react-router-hono-server/cloudflare"
import { createApi } from "@/api"
import {
	type IdentityEnv,
	identifyPlatformUser,
	requireCsrf,
	requireDashboardAuth,
} from "@/auth.middleware"
import type { PlatformCredential } from "@/auth.server"
import {
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
	memberProvisioningContext,
	meridianContext,
	slatesContext,
} from "@/context"
import { createGitApp } from "@/git.server"
import { platformContext } from "@/platform.middleware"

export { SlateDatabase } from "@usecontextlayer/shared/database-worker"
export { SlateAgent } from "@/agent-runtime"
export { Execution } from "@/execution.server"
export { Meridian } from "@/meridian"
export { Provisioning } from "@/provisioning.server"

const publicDashboardPaths = ["/dashboard/chrome/slates/*", "/dashboard/__manifest"]

export default await createHonoServer<IdentityEnv<PlatformCredential>>({
	configure(app) {
		app.use(platformContext)
		app.use("/dashboard/*", async (c, next) => {
			await next()
			if (!c.res.headers.has("Content-Security-Policy"))
				c.header("Content-Security-Policy", "frame-ancestors 'none'")
		})
		app.route("/api", createApi())
		app.use("*", except("/dashboard/__manifest", identifyPlatformUser))
		app.use("*", requireCsrf)
		app.route("/git", createGitApp())
		app.use("/dashboard/*", except(publicDashboardPaths, requireDashboardAuth))
		app.get("/", (c) => c.redirect("/dashboard"))
	},
	defaultLogger: false,
	getLoadContext(c) {
		const context = new RouterContextProvider()
		context.set(databaseContext, c.var.db)
		context.set(slatesContext, c.env.SLATES)
		context.set(artifactsContext, c.env.ARTIFACTS)
		context.set(identityContext, c.var.identity ?? null)
		context.set(configContext, c.var.config)
		context.set(memberProvisioningContext, c.env.MEMBER_PROVISIONING)
		context.set(meridianContext, c.env.MERIDIAN)
		return context
	},
})
