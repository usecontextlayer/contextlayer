import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { errors } from "jose"
import { appSchema, listedAppSchema } from "@/apps.schema"
import { createApp, listApps, resolveApp } from "@/apps.server"
import { authenticate, userSchema } from "@/auth.server"
import type { PlatformEnv } from "@/context"

export function createApi() {
	const api = new OpenAPIHono<PlatformEnv>()
	api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
		scheme: "bearer",
		type: "http",
	})
	api.openapi(
		createRoute({
			method: "get",
			operationId: "getCurrentUser",
			path: "/me",
			responses: {
				200: {
					content: { "application/json": { schema: userSchema } },
					description: "Authenticated ContextLayer user",
				},
				401: { description: "A valid ContextLayer access token is required" },
			},
			security: [{ bearerAuth: [] }],
		}),
		async (c) => {
			const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1]
			let user = null
			try {
				if (token) user = await authenticate(token, c.var.config.CTX_AUTH_ISSUER)
			} catch (error) {
				if (!(error instanceof errors.JOSEError || error instanceof z.ZodError))
					throw error
			}
			if (!user) {
				c.header("WWW-Authenticate", 'Bearer realm="ContextLayer"')
				return c.body(null, 401)
			}
			return c.json(user, 200)
		},
	)
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
			const app = await resolveApp(c.var.db, c.req.valid("query").hostname)
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
		async (c) => c.json({ apps: await listApps(c.var.db, c.env.ARTIFACTS) }, 200),
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
		async (c) =>
			c.json(
				await createApp(c.var.db, c.env.ARTIFACTS, c.var.config.CTX_APPS_DOMAIN),
				201,
			),
	)
	api.doc31("/openapi.json", {
		info: { title: "ContextLayer Platform", version: "0.1.0" },
		openapi: "3.1.0",
		servers: [{ url: "/api" }],
	})
	return api
}
