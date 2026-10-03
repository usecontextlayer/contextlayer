import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi"
import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import { errors } from "jose"
import {
	appConnectionsRequestSchema,
	appConnectionsSchema,
	appTargetSchema,
	assignmentSchema,
} from "@/app-connections.schema"
import { assignAppConnection, listAppConnections } from "@/app-connections.server"
import { appSchema, listedAppSchema } from "@/apps.schema"
import { createApp, listApps, resolveApp } from "@/apps.server"
import { authenticateAccessToken, authenticateSession, userSchema } from "@/auth.server"
import {
	authorizeConnectionSchema,
	connectionLinkSchema,
	connectionsSchema,
} from "@/connections.schema"
import { authorizeConnection, listConnections } from "@/connections.server"
import type { PlatformEnv } from "@/context"
import { toolCallSchema, toolResultSchema } from "@/tools.schema"
import { callTool } from "@/tools.server"

const security: RouteConfig["security"] = [{ bearerAuth: [] }, { viewerCookie: [] }]

const requireAuth = createMiddleware<
	PlatformEnv & { Variables: { user: z.infer<typeof userSchema> } }
>(async (c, next) => {
	const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1]
	let user = null
	if (token) {
		try {
			user = await authenticateAccessToken(token, c.var.config.CTX_AUTH_ISSUER)
		} catch (error) {
			if (!(error instanceof errors.JOSEError || error instanceof z.ZodError)) throw error
		}
	} else {
		const session = getCookie(c, "__Secure-ctx_viewer")
		if (session) user = await authenticateSession(session, c.var.config.CTX_AUTH_ISSUER)
	}
	if (!user) {
		c.header("WWW-Authenticate", 'Bearer realm="ContextLayer"')
		return c.body(null, 401)
	}
	c.set("user", user)
	await next()
})

export function createApi() {
	const api = new OpenAPIHono<PlatformEnv>()
	api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
		scheme: "bearer",
		type: "http",
	})
	api.openAPIRegistry.registerComponent("securitySchemes", "viewerCookie", {
		in: "cookie",
		name: "__Secure-ctx_viewer",
		type: "apiKey",
	})
	api.openapi(
		createRoute({
			method: "get",
			middleware: [requireAuth] as const,
			operationId: "getCurrentUser",
			path: "/me",
			responses: {
				200: {
					content: { "application/json": { schema: userSchema } },
					description: "Authenticated ContextLayer user",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
			},
			security,
		}),
		async (c) => c.json(c.var.user, 200),
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
	api.openapi(
		createRoute({
			method: "get",
			middleware: [requireAuth] as const,
			operationId: "listConnections",
			path: "/connections",
			responses: {
				200: {
					content: { "application/json": { schema: connectionsSchema } },
					description: "Connected accounts owned by the authenticated user",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
			},
			security,
		}),
		async (c) =>
			c.json(await listConnections(c.var.config.COMPOSIO_API_KEY, c.var.user.id), 200),
	)
	api.openapi(
		createRoute({
			method: "post",
			middleware: [requireAuth] as const,
			operationId: "authorizeConnection",
			path: "/connections",
			request: {
				body: {
					content: { "application/json": { schema: authorizeConnectionSchema } },
					required: true,
				},
			},
			responses: {
				200: {
					content: { "application/json": { schema: connectionLinkSchema } },
					description: "Composio authorization link for a new private connection",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
			},
			security,
		}),
		async (c) =>
			c.json(
				await authorizeConnection(
					c.var.config.COMPOSIO_API_KEY,
					c.var.user.id,
					c.req.valid("json").toolkit,
				),
				200,
			),
	)
	api.openapi(
		createRoute({
			method: "post",
			middleware: [requireAuth] as const,
			operationId: "listAppConnections",
			path: "/apps/{target}/connections/list",
			request: {
				body: {
					content: { "application/json": { schema: appConnectionsRequestSchema } },
					required: true,
				},
				params: z.object({ target: appTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: appConnectionsSchema } },
					description: "App requirements and connection assignments",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			const result = await listAppConnections(
				c.var.db,
				c.req.valid("param").target,
				c.var.user.id,
				c.req.valid("json").manifest,
			)
			if (!result) return c.notFound()
			return c.json(result, 200)
		},
	)
	api.openapi(
		createRoute({
			method: "post",
			middleware: [requireAuth] as const,
			operationId: "assignAppConnection",
			path: "/apps/{target}/connections/assign",
			request: {
				body: {
					content: { "application/json": { schema: assignmentSchema } },
					required: true,
				},
				params: z.object({ target: appTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: assignmentSchema } },
					description: "Saved individual connection assignment",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			const result = await assignAppConnection(
				c.var.db,
				c.req.valid("param").target,
				c.var.user.id,
				c.req.valid("json"),
			)
			if (!result) return c.notFound()
			return c.json(result, 200)
		},
	)
	api.openapi(
		createRoute({
			method: "post",
			middleware: [requireAuth] as const,
			operationId: "callTool",
			path: "/apps/{id}/tools/call",
			request: {
				body: {
					content: { "application/json": { schema: toolCallSchema } },
					required: true,
				},
				params: appSchema.pick({ id: true }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: toolResultSchema } },
					description: "Composio tool result, error, and log ID",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
				404: { description: "No connection assignment for this app, user, and slug" },
			},
			security,
		}),
		async (c) => {
			const result = await callTool(
				c.var.db,
				c.var.config.COMPOSIO_API_KEY,
				c.req.valid("param").id,
				c.var.user.id,
				c.req.valid("json"),
			)
			if (!result) return c.notFound()
			return c.json(result, 200)
		},
	)
	api.doc31("/openapi.json", {
		info: { title: "ContextLayer Platform", version: "0.1.0" },
		openapi: "3.1.0",
		servers: [{ url: "/api" }],
	})
	return api
}
