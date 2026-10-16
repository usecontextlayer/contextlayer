import { except } from "hono/combine"
import { RouterContextProvider } from "react-router"
import { createHonoServer } from "react-router-hono-server/cloudflare"
import { createApi } from "@/api"
import {
	identifyUser,
	type OwnerIdentityEnv,
	requireCsrf,
	requireDashboardAuth,
} from "@/auth.middleware"
import {
	agentsContext,
	artifactsContext,
	configContext,
	databaseContext,
	databasesContext,
	identityContext,
	slatesContext,
} from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import { createGitApp } from "@/git.server"

export { SlateDatabase } from "@usecontextlayer/shared/database-worker"
export { SlateAgentJob } from "@/agent-job"
export { SlateAgent } from "@/agent-runtime"
export { Execution } from "@/execution.server"
export { Provisioning } from "@/provisioning.server"

const publicDashboardPaths = ["/dashboard/chrome/slates/*", "/dashboard/__manifest"]

export default await createHonoServer<OwnerIdentityEnv>({
	configure(app) {
		app.use(async (c, next) => {
			const config = parsePlatformEnv(c.env)
			const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
			c.set("config", config)
			c.set("db", db)
			try {
				await next()
			} finally {
				c.executionCtx.waitUntil(db.destroy())
			}
		})
		app.use("/dashboard/chrome/slates/*", async (c, next) => {
			const local = new URL(c.req.url).hostname === "localhost"
			await next()
			c.header(
				"Content-Security-Policy",
				`frame-ancestors https://*.${c.var.config.CTX_SLATES_DOMAIN}${local ? " http://localhost:*" : ""}; base-uri 'none'; object-src 'none'; form-action 'self' https://connect.composio.dev https://dashboard.composio.dev`,
			)
		})
		app.route("/api", createApi())
		app.use("*", except("/dashboard/__manifest", identifyUser))
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
		context.set(databasesContext, c.env.DATABASES)
		context.set(agentsContext, c.env.AGENTS)
		return context
	},
})
