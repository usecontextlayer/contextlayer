import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { appSchema, listedAppSchema } from "@/apps.schema"
import { createApp, listApps, resolveApp } from "@/apps.server"
import type { ArtifactsClient } from "@/artifacts.server"
import type { PlatformDb } from "@/database"

export function createApi(
	db: PlatformDb,
	artifacts: ArtifactsClient,
	appsDomain: string,
) {
	const api = new OpenAPIHono()
	api.openapi(
		createRoute({
			method: "get",
			operationId: "resolveApp",
			path: "/apps/resolve",
			request: { query: z.object({ hostname: z.hostname().toLowerCase() }) },
			responses: {
				200: {
					content: { "application/json": { schema: appSchema.pick({ id: true }) } },
					description: "App ID assigned to the public hostname",
				},
				404: { description: "No app has this public hostname" },
			},
		}),
		async (c) => {
			const app = await resolveApp(db, c.req.valid("query").hostname)
			if (!app) return c.notFound()
			return c.json(app, 200)
		},
	)
	api.openapi(
		createRoute({
			method: "get",
			operationId: "listApps",
			path: "/apps",
			responses: {
				200: {
					content: {
						"application/json": { schema: z.object({ apps: z.array(listedAppSchema) }) },
					},
					description: "Platform apps",
				},
			},
		}),
		async (c) => c.json({ apps: await listApps(db, artifacts) }, 200),
	)
	api.openapi(
		createRoute({
			method: "post",
			operationId: "createApp",
			path: "/apps",
			responses: {
				201: {
					content: { "application/json": { schema: appSchema } },
					description: "Created app with an immutable ID and public hostname",
				},
			},
		}),
		async (c) => c.json(await createApp(db, artifacts, appsDomain), 201),
	)
	api.doc31("/openapi.json", {
		info: { title: "ContextLayer Platform", version: "0.1.0" },
		openapi: "3.1.0",
		servers: [{ url: "/api" }],
	})
	return api
}
