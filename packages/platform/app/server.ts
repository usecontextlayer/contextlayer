import { except } from "hono/combine"
import { csrf } from "hono/csrf"
import { RouterContextProvider } from "react-router"
import { createHonoServer } from "react-router-hono-server/cloudflare"
import { createApi } from "@/api"
import { type IdentityEnv, identifyUser, requireDashboardAuth } from "@/auth.middleware"
import {
	appsContext,
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
} from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import { createGitApp } from "@/git.server"

const publicDashboardPaths = ["/dashboard/chrome/apps/*", "/dashboard/__manifest"]

export default await createHonoServer<IdentityEnv>({
	configure(app) {
		app.use(csrf())
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
		app.use("/dashboard/chrome/apps/*", async (c, next) => {
			const local = new URL(c.req.url).hostname === "localhost"
			await next()
			c.header(
				"Content-Security-Policy",
				`frame-ancestors https://*.${c.var.config.CTX_APPS_DOMAIN}${local ? " http://localhost:*" : ""}; base-uri 'none'; object-src 'none'; form-action 'self'`,
			)
		})
		app.route("/api", createApi())
		app.use("*", except("/dashboard/__manifest", identifyUser))
		app.route("/git", createGitApp())
		app.use("/dashboard/*", except(publicDashboardPaths, requireDashboardAuth))
		app.get("/", (c) => c.redirect("/dashboard"))
	},
	defaultLogger: false,
	getLoadContext(c) {
		const context = new RouterContextProvider()
		context.set(databaseContext, c.var.db)
		context.set(appsContext, c.env.APPS)
		context.set(artifactsContext, c.env.ARTIFACTS)
		context.set(identityContext, c.var.identity ?? null)
		context.set(configContext, c.var.config)
		return context
	},
})
