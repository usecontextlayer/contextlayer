import { type Handler, Hono } from "hono"
import { proxy } from "hono/proxy"
import { z } from "zod"
import { appSchema } from "@/apps.schema"
import { getGitAccess } from "@/apps.server"
import type { ArtifactsClient } from "@/artifacts.server"

import type { PlatformDb } from "@/database"

const serviceSchema = z.enum(["git-upload-pack", "git-receive-pack"])

export function createGitApp(db: PlatformDb, artifacts: ArtifactsClient) {
	const app = new Hono()
	const handle: Handler = async (c) => {
		const id = appSchema.shape.id.parse(c.req.param("id"))
		const service = serviceSchema.parse(
			c.req.method === "GET" ? c.req.query("service") : c.req.param("service"),
		)
		const path = c.req.method === "GET" ? "/info/refs" : `/${service}`
		const access = await getGitAccess(db, artifacts, id, service === "git-receive-pack")
		if (!access) return c.notFound()
		const url = new URL(access.remote)
		url.pathname += path
		url.search = new URL(c.req.url).search
		return proxy(url, {
			headers: {
				authorization: `Bearer ${access.token}`,
				"content-type": c.req.header("content-type"),
				"git-protocol": c.req.header("git-protocol"),
			},
			raw: c.req.raw,
		})
	}
	app.get("/:id/info/refs", handle)
	app.post("/:id/:service", handle)
	return app
}
