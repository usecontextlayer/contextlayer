import { RouterContextProvider } from "react-router"
import { createHonoServer } from "react-router-hono-server/cloudflare"
import { createApi } from "@/api"
import { type IdentityEnv, identifyUser, requireDashboardAuth } from "@/auth.middleware"
import {
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
} from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import { createGitApp } from "@/git.server"

export default await createHonoServer<IdentityEnv>({
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
		app.use("*", identifyUser)
		app.route("/git", createGitApp())
		app.route("/api", createApi())
		app.use("/dashboard/*", requireDashboardAuth)
		app.get("/", (c) => c.redirect("/dashboard/apps"))
	},
	defaultLogger: false,
	getLoadContext(c) {
		const context = new RouterContextProvider()
		context.set(databaseContext, c.var.db)
		context.set(artifactsContext, c.env.ARTIFACTS)
		if (c.var.identity) context.set(identityContext, c.var.identity)
		context.set(configContext, c.var.config)
		return context
	},
})
