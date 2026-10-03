import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi"
import {
	appConnectionsRequestSchema,
	appConnectionsSchema,
	assignmentSchema,
} from "@/app-connections.schema"
import { assignAppConnection, listAppConnections } from "@/app-connections.server"
import {
	type AuthenticatedViewingEnv,
	requireAppViewing,
	type ViewingEnv,
} from "@/apps.middleware"
import {
	appSchema,
	appTargetSchema,
	listedAppSchema,
	resolveAppQuerySchema,
} from "@/apps.schema"
import { createApp, listApps } from "@/apps.server"
import { type AuthenticatedEnv, type IdentityEnv, requireAuth } from "@/auth.middleware"
import { userSchema } from "@/auth.server"
import {
	authorizeConnectionSchema,
	connectionLinkSchema,
	connectionsSchema,
} from "@/connections.schema"
import { authorizeConnection, listConnections } from "@/connections.server"
import { toolCallSchema, toolResultSchema } from "@/tools.schema"
import { callTool } from "@/tools.server"

const security: NonNullable<RouteConfig["security"]> = [
	{ bearerAuth: [] },
	{ viewerCookie: [] },
	{ webCookie: [] },
	{ localWebCookie: [] },
]

export function createApi() {
	const api = new OpenAPIHono<IdentityEnv>()
	api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
		scheme: "bearer",
		type: "http",
	})
	api.openAPIRegistry.registerComponent("securitySchemes", "viewerCookie", {
		in: "cookie",
		name: "__Secure-ctx_viewer",
		type: "apiKey",
	})
	api.openAPIRegistry.registerComponent("securitySchemes", "webCookie", {
		in: "cookie",
		name: "__Secure-better-auth.session_token",
		type: "apiKey",
	})
	api.openAPIRegistry.registerComponent("securitySchemes", "localWebCookie", {
		in: "cookie",
		name: "better-auth.session_token",
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
		async (c) => c.json(c.var.identity.user, 200),
	)
	const viewing = new OpenAPIHono<ViewingEnv>()
	viewing.use("*", requireAppViewing)
	viewing.openapi(
		createRoute({
			method: "get",
			operationId: "resolveApp",
			path: "/",
			request: { query: resolveAppQuerySchema },
			responses: {
				200: {
					content: { "application/json": { schema: appSchema.pick({ id: true }) } },
					description: "App ID authorized for viewing by this caller",
				},
				401: { description: "Sign-in is required to view this private app" },
				403: { description: "This user cannot view this private app" },
				404: { description: "No app has this public hostname" },
			},
			security: [...security, {}],
		}),
		async (c) => c.json({ id: c.var.appAccess.app.id }, 200),
	)
	api.route("/apps/resolve", viewing)
	const catalog = new OpenAPIHono<AuthenticatedEnv>()
	catalog.use("*", requireAuth)
	catalog.openapi(
		createRoute({
			method: "get",
			operationId: "listApps",
			path: "/",
			responses: {
				200: {
					content: {
						"application/json": { schema: z.object({ apps: z.array(listedAppSchema) }) },
					},
					description: "Apps owned by this user or their organizations",
				},
				401: { description: "A valid ContextLayer login is required" },
			},
			security,
		}),
		async (c) =>
			c.json(
				{
					apps: await listApps(
						c.var.db,
						c.env.ARTIFACTS,
						c.var.identity,
						c.var.config.CTX_AUTH_ISSUER,
					),
				},
				200,
			),
	)
	catalog.openapi(
		createRoute({
			method: "post",
			operationId: "createApp",
			path: "/",
			responses: {
				201: {
					content: { "application/json": { schema: appSchema } },
					description:
						"App owned by the authenticated user with an immutable ID and public hostname",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
			},
			security,
		}),
		async (c) =>
			c.json(
				await createApp(c.var.db, c.env.ARTIFACTS, c.var.config.CTX_APPS_DOMAIN, {
					id: c.var.identity.user.id,
					type: "user",
				}),
				201,
			),
	)
	api.route("/apps", catalog)
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
			c.json(
				await listConnections(c.var.config.COMPOSIO_API_KEY, c.var.identity.user.id),
				200,
			),
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
					c.var.identity.user.id,
					c.req.valid("json").toolkit,
				),
				200,
			),
	)
	const appOperations = new OpenAPIHono<AuthenticatedViewingEnv>()
	appOperations.use("*", requireAuth, requireAppViewing)
	appOperations.openapi(
		createRoute({
			method: "post",
			operationId: "listAppConnections",
			path: "/connections/list",
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
				403: { description: "This user cannot view this private app" },
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			const result = await listAppConnections(
				c.var.db,
				c.var.appAccess,
				c.req.valid("json").manifest,
			)
			return c.json(result, 200)
		},
	)
	appOperations.openapi(
		createRoute({
			method: "post",
			operationId: "assignAppConnection",
			path: "/connections/assign",
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
				403: { description: "This user cannot view this private app" },
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			const result = await assignAppConnection(
				c.var.db,
				c.var.appAccess,
				c.req.valid("json"),
			)
			return c.json(result, 200)
		},
	)
	appOperations.openapi(
		createRoute({
			method: "post",
			operationId: "callTool",
			path: "/tools/call",
			request: {
				body: {
					content: { "application/json": { schema: toolCallSchema } },
					required: true,
				},
				params: z.object({ target: appTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: toolResultSchema } },
					description: "Composio tool result, error, and log ID",
				},
				401: {
					description: "A valid ContextLayer access token or viewer session is required",
				},
				403: { description: "This user cannot view this private app" },
				404: { description: "App or connection assignment not found" },
			},
			security,
		}),
		async (c) => {
			const result = await callTool(
				c.var.db,
				c.var.config.COMPOSIO_API_KEY,
				c.var.appAccess,
				c.req.valid("json"),
			)
			if (!result) return c.notFound()
			return c.json(result, 200)
		},
	)
	api.route("/apps/:target", appOperations)
	api.doc31("/openapi.json", {
		info: { title: "ContextLayer Platform", version: "0.1.0" },
		openapi: "3.1.0",
		servers: [{ url: "/api" }],
	})
	return api
}
