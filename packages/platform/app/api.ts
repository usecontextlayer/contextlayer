import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi"
import { createPolarCore, webhooks } from "@polar-sh/sdk/2026-10"
import { recordAppUsage, resolvedAppSchema } from "@usecontextlayer/shared/app-usage"
import {
	agentJobParamsSchema,
	agentJobRequestSchema,
	agentJobSchema,
	agentParamsSchema,
	agentSchema,
} from "@/agents.schema"
import { getAgent, getAgentJob, startAgentJob } from "@/agents.server"
import {
	appConnectionsRequestSchema,
	appConnectionsSchema,
	assignAppConnectionRequestSchema,
	assignmentSchema,
} from "@/app-connections.schema"
import { assignAppConnection, listAppConnections } from "@/app-connections.server"
import { appMemberSchema } from "@/app-members.schema"
import { joinApp } from "@/app-members.server"
import {
	type AuthenticatedViewingEnv,
	requireAppViewing,
	type ViewingEnv,
} from "@/apps.middleware"
import {
	type AppOwnerFilter,
	appSchema,
	appTargetSchema,
	createAppRequestSchema,
	listAppsQuerySchema,
	listedAppSchema,
	resolveAppQuerySchema,
	updateAppVisibilityRequestSchema,
} from "@/apps.schema"
import { createApp, listApps, updateAppVisibility } from "@/apps.server"
import {
	type AuthenticatedEnv,
	type IdentityEnv,
	identifyUser,
	identifyViewer,
	requireAuth,
} from "@/auth.middleware"
import { requireAppSubscription } from "@/billing.middleware"
import { saveCustomerState } from "@/billing.server"
import {
	authorizeConnectionSchema,
	connectionLinkSchema,
	connectionsSchema,
} from "@/connections.schema"
import { authorizeConnection, listConnections } from "@/connections.server"
import { getAppManifest } from "@/manifest.server"
import { getAppOwner } from "@/owner"
import { ownerParamsSchema } from "@/owner.schema"
import {
	secretParamsSchema,
	secretSchema,
	setSecretRequestSchema,
} from "@/secrets.schema"
import { dropSharedSecret, setSharedSecret } from "@/secrets.server"
import { toolCallSchema, toolResultSchema } from "@/tools.schema"
import { callTool } from "@/tools.server"

const security: NonNullable<RouteConfig["security"]> = [
	{ bearerAuth: [] },
	{ webCookie: [] },
	{ localWebCookie: [] },
]

export function createApi() {
	const api = new OpenAPIHono<IdentityEnv>()
	api.post("/polar/webhooks", async (c) => {
		let payload: webhooks.WebhookPayload
		try {
			payload = await webhooks.validateEvent(
				await c.req.text(),
				c.req.header(),
				c.var.config.POLAR_WEBHOOK_SECRET,
			)
		} catch (error) {
			if (error instanceof webhooks.PolarWebhookVerificationError)
				return c.body(null, 403)
			throw error
		}
		if (payload.type === "customer.state_changed") {
			await saveCustomerState(c.var.db, payload.data, payload.timestamp)
		}
		return c.body(null, 204)
	})
	api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
		scheme: "bearer",
		type: "http",
	})
	api.openAPIRegistry.registerComponent("securitySchemes", "viewerCookie", {
		in: "cookie",
		name: "ctx-viewer-auth",
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
	const viewing = new OpenAPIHono<ViewingEnv>()
	viewing.use("*", identifyViewer, requireAppViewing, requireAppSubscription)
	viewing.openapi(
		createRoute({
			method: "get",
			operationId: "resolveApp",
			path: "/",
			request: { query: resolveAppQuerySchema },
			responses: {
				200: {
					content: { "application/json": { schema: resolvedAppSchema } },
					description: "App ID authorized for viewing by this caller",
				},
				401: { description: "Sign-in is required to view this private app" },
				402: { description: "The app owner needs an active subscription" },
				403: { description: "This user cannot view this private app" },
				404: { description: "No app has this public hostname" },
			},
			security: [...security, { viewerCookie: [] }, {}],
		}),
		async (c) =>
			c.json(
				{ id: c.var.appAccess.app.id, owner: getAppOwner(c.var.appAccess.app) },
				200,
			),
	)
	api.route("/apps/resolve", viewing)
	const tools = new OpenAPIHono<AuthenticatedViewingEnv>()
	tools.use("*", identifyViewer, requireAuth, requireAppViewing, requireAppSubscription)
	tools.openapi(
		createRoute({
			method: "post",
			operationId: "callTool",
			path: "/call",
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
				402: { description: "The app owner needs an active subscription" },
				403: { description: "App viewing or local manifest access is forbidden" },
				404: { description: "App or connection assignment not found" },
			},
			security: [...security, { viewerCookie: [] }],
		}),
		async (c) => {
			const { manifest, ...call } = c.req.valid("json")
			const snapshot = await getAppManifest(c.var.appAccess.app, c.env.APPS, manifest)
			const result = await callTool(
				c.var.db,
				c.var.config.COMPOSIO_API_KEY,
				c.var.appAccess,
				c.var.config.CTX_AUTH_ISSUER,
				call,
				snapshot,
			)
			if (!result.allowed) return c.body(null, result.reason === "forbidden" ? 403 : 404)
			const polar = createPolarCore({
				accessToken: c.var.config.POLAR_ACCESS_TOKEN,
				environment: c.var.config.POLAR_ENVIRONMENT,
			})
			const app = c.var.appAccess.app
			c.executionCtx.waitUntil(
				recordAppUsage(polar, { id: app.id, owner: getAppOwner(app) }, "tool_call"),
			)
			return c.json(result.result, 200)
		},
	)
	api.route("/apps/:target/tools", tools)
	api.use("*", identifyUser)
	const catalog = new OpenAPIHono<AuthenticatedEnv>()
	catalog.use("*", requireAuth)
	catalog.openapi(
		createRoute({
			description:
				"List manageable apps. Supply either owner_user_id or owner_organization_id, or omit both to list all manageable apps.",
			method: "get",
			operationId: "listApps",
			path: "/",
			request: { query: listAppsQuerySchema },
			responses: {
				200: {
					content: {
						"application/json": { schema: z.object({ apps: z.array(listedAppSchema) }) },
					},
					description: "Apps owned by this user or their organizations",
				},
				400: { description: "Invalid ownership filter; supply at most one owner ID" },
				401: { description: "A valid ContextLayer login is required" },
			},
			security,
		}),
		async (c) => {
			const query = c.req.valid("query")
			const filter: AppOwnerFilter =
				query.owner_user_id !== undefined
					? { id: query.owner_user_id, type: "user" }
					: query.owner_organization_id !== undefined
						? { id: query.owner_organization_id, type: "organization" }
						: { type: "all" }
			return c.json(
				{
					apps: await listApps(
						c.var.db,
						c.env.ARTIFACTS,
						c.var.identity,
						c.var.config.CTX_AUTH_ISSUER,
						filter,
					),
				},
				200,
			)
		},
	)
	catalog.openapi(
		createRoute({
			method: "post",
			operationId: "createApp",
			path: "/",
			request: {
				body: {
					content: { "application/json": { schema: createAppRequestSchema } },
					required: false,
				},
			},
			responses: {
				201: {
					content: { "application/json": { schema: appSchema } },
					description:
						"App owned by the authenticated user or selected organization, with an immutable ID and public hostname",
				},
				400: { description: "Invalid app creation input" },
				401: {
					description: "A valid ContextLayer login is required",
				},
				404: { description: "The organization slug is not in this user's memberships" },
			},
			security,
		}),
		async (c) => {
			const app = await createApp(
				c.var.db,
				c.env.ARTIFACTS,
				c.var.config.CTX_APPS_DOMAIN,
				c.var.identity,
				c.var.config.CTX_AUTH_ISSUER,
				c.req.valid("json"),
			)
			if (!app) return c.body(null, 404)
			return c.json(app, 201)
		},
	)
	api.route("/apps", catalog)
	const secrets = new OpenAPIHono<AuthenticatedEnv>()
	secrets.use("*", requireAuth)
	secrets.openapi(
		createRoute({
			method: "put",
			operationId: "setSharedSecret",
			path: "/{type}/{owner_id}/{name}",
			request: {
				body: {
					content: { "application/json": { schema: setSecretRequestSchema } },
					required: true,
				},
				params: secretParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: secretSchema } },
					description: "Saved secret's Owner and name; never its value",
				},
				400: { description: "Invalid Owner, secret name, or value" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "This user cannot manage this Owner's secrets" },
			},
			security,
		}),
		async (c) => {
			const { name, owner_id, type } = c.req.valid("param")
			const result = await setSharedSecret(
				c.var.config,
				c.var.identity,
				{ id: owner_id, type },
				name,
				c.req.valid("json"),
			)
			if (!result.allowed) return c.body(null, 403)
			return c.json(result.secret, 200)
		},
	)
	secrets.openapi(
		createRoute({
			method: "delete",
			operationId: "dropSharedSecret",
			path: "/{type}/{owner_id}/{name}",
			request: { params: secretParamsSchema },
			responses: {
				200: {
					content: { "application/json": { schema: secretSchema } },
					description: "Dropped secret's Owner and name; never its value",
				},
				400: { description: "Invalid Owner or secret name" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "This user cannot manage this Owner's secrets" },
			},
			security,
		}),
		async (c) => {
			const { name, owner_id, type } = c.req.valid("param")
			const result = await dropSharedSecret(
				c.var.config,
				c.var.identity,
				{ id: owner_id, type },
				name,
			)
			if (!result.allowed) return c.body(null, 403)
			return c.json(result.secret, 200)
		},
	)
	api.route("/secrets", secrets)
	api.openapi(
		createRoute({
			method: "get",
			middleware: [requireAuth] as const,
			operationId: "listConnections",
			path: "/connections/{type}/{owner_id}",
			request: { params: ownerParamsSchema },
			responses: {
				200: {
					content: { "application/json": { schema: connectionsSchema } },
					description: "Connected accounts belonging to the selected Owner",
				},
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "This user cannot manage this Owner's connections" },
			},
			security,
		}),
		async (c) => {
			const { owner_id, type } = c.req.valid("param")
			const result = await listConnections(c.var.config, c.var.identity, {
				id: owner_id,
				type,
			})
			if (!result.allowed) return c.body(null, 403)
			return c.json({ connections: result.connections }, 200)
		},
	)
	api.openapi(
		createRoute({
			method: "post",
			middleware: [requireAuth] as const,
			operationId: "authorizeConnection",
			path: "/connections/{type}/{owner_id}",
			request: {
				body: {
					content: { "application/json": { schema: authorizeConnectionSchema } },
					required: true,
				},
				params: ownerParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: connectionLinkSchema } },
					description:
						"Composio authorization link for the selected Owner's private connection",
				},
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "This user cannot manage this Owner's connections" },
			},
			security,
		}),
		async (c) => {
			const { owner_id, type } = c.req.valid("param")
			const result = await authorizeConnection(
				c.var.config,
				c.var.identity,
				{ id: owner_id, type },
				c.req.valid("json").toolkit,
			)
			if (!result.allowed) return c.body(null, 403)
			return c.json(result.link, 200)
		},
	)
	const appOperations = new OpenAPIHono<AuthenticatedViewingEnv>()
	appOperations.use("*", requireAuth, requireAppViewing)
	appOperations.openapi(
		createRoute({
			method: "post",
			operationId: "joinApp",
			path: "/join",
			request: { params: z.object({ target: appTargetSchema }) },
			responses: {
				200: {
					content: { "application/json": { schema: appMemberSchema } },
					description:
						"The authenticated user's app membership, enabling unattended participation",
				},
				400: { description: "Invalid app target" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Public apps cannot be joined, or private app viewing is forbidden",
				},
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			if (c.var.appAccess.app.visibility === "public") return c.body(null, 403)
			return c.json(await joinApp(c.var.db, c.var.appAccess), 200)
		},
	)
	appOperations.openapi(
		createRoute({
			method: "get",
			operationId: "getAgent",
			path: "/agents/{name}",
			request: {
				params: agentParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: agentSchema } },
					description: "The agent's instructions at the latest commit on main",
				},
				400: { description: "Invalid app target or agent name" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Only the owner or owning organization members may inspect agent source",
				},
				404: { description: "App or agent instructions not found" },
			},
			security,
		}),
		async (c) => {
			const result = await getAgent(
				c.env.ARTIFACTS,
				c.var.appAccess,
				c.var.config.CTX_AUTH_ISSUER,
				c.req.valid("param").name,
			)
			if (!result.allowed) {
				const status = {
					forbidden: 403,
					"not-found": 404,
					"sign-in-required": 401,
				} as const
				return c.body(null, status[result.reason])
			}
			return c.json(result.agent, 200)
		},
	)
	const jobs = new OpenAPIHono<AuthenticatedViewingEnv>()
	jobs.use("*", async (c, next) => {
		// Public apps are temporarily excluded from jobs.
		if (c.var.appAccess.app.visibility === "public") return c.body(null, 403)
		await next()
	})
	jobs.openapi(
		createRoute({
			method: "post",
			operationId: "startAgentJob",
			path: "/",
			request: {
				body: {
					content: { "application/json": { schema: agentJobRequestSchema } },
					required: true,
				},
				params: agentParamsSchema,
			},
			responses: {
				202: {
					content: { "application/json": { schema: agentJobSchema } },
					description: "Accepted agent job with its ID and native Think status",
				},
				400: { description: "Invalid app target, agent name, or prompt" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "App viewing is forbidden or the app is public" },
				404: { description: "App or published agent not found" },
			},
			security,
		}),
		async (c) => {
			const result = await startAgentJob(
				c.var.db,
				c.env.ARTIFACTS,
				c.env.APPS,
				c.env.AGENTS,
				c.var.appAccess,
				c.var.config.CTX_AUTH_ISSUER,
				{ ...c.req.valid("json"), name: c.req.valid("param").name },
			)
			if (!result.allowed) return c.body(null, 404)
			return c.json(result.job, 202)
		},
	)
	jobs.openapi(
		createRoute({
			method: "get",
			operationId: "getAgentJob",
			path: "/{id}",
			request: { params: agentJobParamsSchema },
			responses: {
				200: {
					content: { "application/json": { schema: agentJobSchema } },
					description: "Native Think job status and saved assistant text result",
				},
				400: { description: "Invalid app target, agent name, or job ID" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "App viewing is forbidden or the app is public" },
				404: { description: "App or agent job not found" },
			},
			security,
		}),
		async (c) => {
			const { id, name } = c.req.valid("param")
			const job = await getAgentJob(c.env.AGENTS, c.var.appAccess.app, name, id)
			if (!job) return c.body(null, 404)
			return c.json(job, 200)
		},
	)
	appOperations.route("/agents/:name/jobs", jobs)
	appOperations.openapi(
		createRoute({
			method: "patch",
			operationId: "updateAppVisibility",
			path: "/",
			request: {
				body: {
					content: { "application/json": { schema: updateAppVisibilityRequestSchema } },
					required: true,
				},
				params: z.object({ target: appTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: appSchema } },
					description: "App with its saved visibility",
				},
				400: { description: "Invalid app target or visibility" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Only the owner or owning organization members may update this app",
				},
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			const result = await updateAppVisibility(
				c.var.db,
				c.var.appAccess,
				c.var.config.CTX_AUTH_ISSUER,
				c.req.valid("json"),
			)
			if (!result.allowed) return c.body(null, 403)
			return c.json(result.app, 200)
		},
	)
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
					description: "A valid ContextLayer login is required",
				},
				403: { description: "This user cannot view this private app" },
				404: { description: "App not found" },
			},
			security,
		}),
		async (c) => {
			const snapshot = await getAppManifest(
				c.var.appAccess.app,
				c.env.APPS,
				c.req.valid("json").manifest,
			)
			const result = await listAppConnections(c.var.db, c.var.appAccess, snapshot)
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
					content: { "application/json": { schema: assignAppConnectionRequestSchema } },
					required: true,
				},
				params: z.object({ target: appTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: assignmentSchema } },
					description: "Saved viewer or owner connection assignment",
				},
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "App viewing or owner connection management is forbidden" },
				404: { description: "App or connection requirement not found" },
			},
			security,
		}),
		async (c) => {
			const { manifest, ...assignment } = c.req.valid("json")
			const snapshot = await getAppManifest(c.var.appAccess.app, c.env.APPS, manifest)
			const result = await assignAppConnection(
				c.var.db,
				c.var.appAccess,
				c.var.config.CTX_AUTH_ISSUER,
				assignment,
				snapshot,
			)
			if (!result.allowed) return c.body(null, result.reason === "forbidden" ? 403 : 404)
			return c.json(result.assignment, 200)
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
