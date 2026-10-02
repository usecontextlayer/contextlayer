import { RouterContextProvider } from "react-router"
import { createHonoServer } from "react-router-hono-server/node"
import { createApi } from "@/api"
import { createArtifactsClient } from "@/artifacts.server"
import { artifactsContext, databaseContext } from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import { createGitApp } from "@/git.server"

const env = parsePlatformEnv(process.env)
const artifacts = createArtifactsClient(env)
const db = createPlatformDb(env.CTX_PLATFORM_DATABASE_URL)

export default await createHonoServer({
	configure(app) {
		app.route("/git", createGitApp(db, artifacts))
		app.route("/api", createApi(db, artifacts, env.CTX_APPS_DOMAIN))
		app.get("/", (c) => c.redirect("/dashboard/apps"))
	},
	defaultLogger: false,
	getLoadContext() {
		const context = new RouterContextProvider()
		context.set(databaseContext, db)
		context.set(artifactsContext, artifacts)
		return context
	},
	port: env.CTX_PLATFORM_PORT,
})
