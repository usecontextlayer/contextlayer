import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi"
import { createPolarCore, webhooks } from "@polar-sh/sdk/2026-10"
import type { Resources } from "@usecontextlayer/shared/declaration"
import { noCommitSchema } from "@usecontextlayer/shared/slate-resources"
import {
	recordSlateUsage,
	resolvedSlateSchema,
} from "@usecontextlayer/shared/slate-usage"
import { isAPIError } from "better-auth/api"
import {
	agentJobParamsSchema,
	agentJobQuerySchema,
	agentJobRequestSchema,
	agentJobSchema,
	agentParamsSchema,
	agentSchema,
} from "@/agents.schema"
import { getAgent, getAgentJob, listAgentJobs, startAgentJob } from "@/agents.server"
import {
	getSlateViewerIdentity,
	type IdentityEnv,
	identifyUser,
	type OwnerAuthenticatedEnv,
	type OwnerIdentityEnv,
	requireAuth,
	requireCsrf,
} from "@/auth.middleware"
import type { AuthIdentity } from "@/auth.server"
import {
	checkSlateBilling,
	enrollFreeCustomer,
	saveCustomerState,
} from "@/billing.server"
import {
	connectAccountSchema,
	connectionLinkSchema,
	connectionsSchema,
	personalConnectionsQuerySchema,
} from "@/connections.schema"
import {
	connectAccount,
	listConnections,
	listPersonalConnections,
} from "@/connections.server"
import { getMcpMetadata } from "@/mcp.server"
import { getSlateOwner } from "@/owner"
import { ownerParamsSchema } from "@/owner.schema"
import {
	secretParamsSchema,
	secretSchema,
	setSecretRequestSchema,
} from "@/secrets.schema"
import { dropSharedSecret, setSharedSecret } from "@/secrets.server"
import {
	assignmentSchema,
	assignSlateConnectionRequestSchema,
	slateConnectionsSchema,
} from "@/slate-connections.schema"
import { assignSlateConnection } from "@/slate-connections.server"
import { slateMemberSchema } from "@/slate-members.schema"
import { joinSlate } from "@/slate-members.server"
import {
	slateResourcesRequestSchema,
	slateResourcesSchema,
} from "@/slate-resources.schema"
import {
	getSlateResources,
	listSlateConnections,
	listSlateResources,
} from "@/slate-resources.server"
import {
	type AuthenticatedViewingEnv,
	type OwnerViewingEnv,
	requireSlateViewing,
	slateViewingErrorStatus,
} from "@/slates.middleware"
import {
	createSlateRequestSchema,
	listedSlateSchema,
	listSlatesQuerySchema,
	resolveSlateQuerySchema,
	type SlateOwnerFilter,
	slateSchema,
	slateTargetSchema,
	updateSlateVisibilityRequestSchema,
} from "@/slates.schema"
import {
	createSlate,
	getSlate,
	listSlates,
	resolveSlate,
	resolveSlateForViewing,
	updateSlateVisibility,
} from "@/slates.server"
import {
	connectionRequiredSchema,
	connectionToolCallSchema,
	connectionToolParamsSchema,
	toolResultSchema,
} from "@/tools.schema"
import { callConnectionTool } from "@/tools.server"

const security: NonNullable<RouteConfig["security"]> = [
	{ bearerAuth: [] },
	{ webCookie: [] },
	{ localWebCookie: [] },
]

const noCommitResponse = {
	content: { "application/json": { schema: noCommitSchema } },
	description: "Nothing has been pushed to the slate's main branch yet",
}

export function createApi() {
	const api = new OpenAPIHono<OwnerIdentityEnv>()
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
			await saveCustomerState(c.var.db, payload.data)
		}
		if (payload.type === "customer.created" && payload.data.external_id) {
			const polar = createPolarCore({
				accessToken: c.var.config.POLAR_ACCESS_TOKEN,
				environment: c.var.config.POLAR_ENVIRONMENT,
			})
			await enrollFreeCustomer(polar, payload.data.id, c.var.config.POLAR_FREE_PRODUCT_ID)
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
	const viewing = new OpenAPIHono<IdentityEnv>()
	viewing.openapi(
		createRoute({
			method: "get",
			operationId: "resolveSlate",
			path: "/",
			request: { query: resolveSlateQuerySchema },
			responses: {
				200: {
					content: { "application/json": { schema: resolvedSlateSchema } },
					description: "Slate ID authorized for viewing by this caller",
				},
				401: { description: "Sign-in is required to view this private slate" },
				402: {
					content: { "text/plain": { schema: z.string() } },
					description: "The Owner needs a plan or has exhausted their Free clips",
				},
				403: { description: "This user cannot view this private slate" },
				404: { description: "No slate has this public hostname" },
			},
			security: [...security, { viewerCookie: [] }, {}],
		}),
		async (c) => {
			const input = c.req.valid("query")
			let identity: AuthIdentity | null
			try {
				identity = await getSlateViewerIdentity(c, input)
			} catch (error) {
				if (isAPIError(error) && [401, 403].includes(error.statusCode)) {
					return new Response(null, { headers: error.headers, status: error.statusCode })
				}
				throw error
			}
			const result = await resolveSlateForViewing(
				c.var.db,
				{ public_hostname: input.hostname },
				identity,
				c.var.config.CTX_AUTH_ISSUER,
			)
			if (!result.allowed) return c.body(null, slateViewingErrorStatus[result.reason])
			if (input.pathname !== "/slate.json") {
				const billing = await checkSlateBilling(c.var.db, c.var.config, result.slate)
				if (!billing.allowed) return c.text(billing.message, 402)
			}
			return c.json({ id: result.slate.id, owner: getSlateOwner(result.slate) }, 200)
		},
	)
	api.route("/slates/resolve", viewing)
	api.openapi(
		createRoute({
			method: "get",
			operationId: "getSlateMcpMetadata",
			path: "/slates/mcp/metadata",
			request: { query: resolveSlateQuerySchema.pick({ hostname: true }) },
			responses: {
				200: {
					content: {
						"application/json": {
							schema: z.object({
								authorization_servers: z.array(z.string()).optional(),
								bearer_methods_supported: z.array(z.string()).optional(),
								resource: z.url(),
								scopes_supported: z.array(z.string()).optional(),
							}),
						},
					},
					description:
						"Public OAuth protected-resource metadata for the slate MCP endpoint",
				},
				404: { description: "No slate has this public hostname" },
			},
			security: [{}],
		}),
		async (c) => {
			const slate = await resolveSlate(c.var.db, {
				public_hostname: c.req.valid("query").hostname,
			})
			if (!slate) return c.body(null, 404)
			return c.json(
				await getMcpMetadata(slate.public_hostname, c.var.config.CTX_AUTH_ISSUER),
				200,
			)
		},
	)
	api.use("*", identifyUser, requireCsrf)
	const catalog = new OpenAPIHono<OwnerAuthenticatedEnv>()
	catalog.use("*", requireAuth)
	catalog.openapi(
		createRoute({
			description:
				"List manageable slates. Supply either owner_user_id or owner_organization_id, or omit both to list all manageable slates.",
			method: "get",
			operationId: "listSlates",
			path: "/",
			request: { query: listSlatesQuerySchema },
			responses: {
				200: {
					content: {
						"application/json": {
							schema: z.object({ slates: z.array(listedSlateSchema) }),
						},
					},
					description: "Slates owned by this user or their organizations",
				},
				400: { description: "Invalid ownership filter; supply at most one Owner ID" },
				401: { description: "A valid ContextLayer login is required" },
			},
			security,
		}),
		async (c) => {
			const query = c.req.valid("query")
			const filter: SlateOwnerFilter =
				query.owner_user_id !== undefined
					? { id: query.owner_user_id, type: "personal" }
					: query.owner_organization_id !== undefined
						? { id: query.owner_organization_id, type: "organization" }
						: { type: "all" }
			return c.json(
				{
					slates: await listSlates(
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
			operationId: "createSlate",
			path: "/",
			request: {
				body: {
					content: { "application/json": { schema: createSlateRequestSchema } },
					required: false,
				},
			},
			responses: {
				201: {
					content: { "application/json": { schema: slateSchema } },
					description:
						"Slate owned by the authenticated user or selected organization, with an immutable ID and public hostname",
				},
				400: { description: "Invalid slate creation input" },
				401: {
					description: "A valid ContextLayer login is required",
				},
				404: { description: "The organization slug is not in this user's memberships" },
			},
			security,
		}),
		async (c) => {
			const slate = await createSlate(
				c.var.db,
				c.env.ARTIFACTS,
				c.env.DATABASES,
				c.env.AGENTS,
				c.var.config,
				c.var.identity,
				c.req.valid("json"),
			)
			if (!slate) return c.body(null, 404)
			return c.json(slate, 201)
		},
	)
	catalog.openapi(
		createRoute({
			method: "get",
			operationId: "getSlate",
			path: "/{target}",
			request: { params: z.object({ target: slateTargetSchema }) },
			responses: {
				200: {
					content: { "application/json": { schema: slateSchema } },
					description: "Slate manageable by this user",
				},
				400: { description: "Invalid slate target" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "This user cannot manage this slate" },
				404: { description: "Slate not found" },
			},
			security,
		}),
		async (c) => {
			const result = await getSlate(
				c.var.db,
				c.req.valid("param").target,
				c.var.identity,
				c.var.config.CTX_AUTH_ISSUER,
			)
			if (!result.allowed) {
				const status = {
					forbidden: 403,
					"not-found": 404,
					"sign-in-required": 401,
				} as const
				return c.body(null, status[result.reason])
			}
			return c.json(result.slate, 200)
		},
	)
	api.route("/slates", catalog)
	const secrets = new OpenAPIHono<OwnerAuthenticatedEnv>()
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
	const personalConnections = new OpenAPIHono<OwnerAuthenticatedEnv>()
	personalConnections.use("*", requireAuth)
	personalConnections.openapi(
		createRoute({
			method: "get",
			operationId: "listPersonalConnections",
			path: "/",
			request: { query: personalConnectionsQuerySchema },
			responses: {
				200: {
					content: { "application/json": { schema: connectionsSchema } },
					description:
						"The signed-in user's connected accounts for the requested toolkit",
				},
				400: { description: "A toolkit is required; Owner selectors are not accepted" },
				401: {
					description: "A native web session or ContextLayer access token is required",
				},
			},
			security,
		}),
		async (c) => {
			const result = await listPersonalConnections(
				c.var.config,
				c.var.identity,
				c.req.valid("query").toolkit,
			)
			return c.json(result, 200)
		},
	)
	personalConnections.openapi(
		createRoute({
			method: "post",
			operationId: "callConnectionTool",
			path: "/{connection_id}/tools/call",
			request: {
				body: {
					content: { "application/json": { schema: connectionToolCallSchema } },
					required: true,
				},
				params: connectionToolParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: toolResultSchema } },
					description: "Tool result from the signed-in user's pinned connected account",
				},
				400: { description: "Invalid connected-account tool call" },
				401: {
					description: "A native web session or ContextLayer access token is required",
				},
				402: {
					content: { "text/plain": { schema: z.string() } },
					description: "The Owner needs a plan or has exhausted their Free clips",
				},
				403: { description: "Slate viewing is forbidden" },
				404: { description: "Slate not found" },
			},
			security,
		}),
		async (c) => {
			const result = await callConnectionTool(
				c.var.db,
				c.var.config,
				c.var.identity,
				c.req.valid("param").connection_id,
				c.req.valid("json"),
			)
			if (!result.allowed) {
				if (
					result.reason === "subscription-required" ||
					result.reason === "credits-exhausted"
				)
					return c.text(result.message, 402)
				const status = {
					forbidden: 403,
					"not-found": 404,
					"sign-in-required": 401,
				} as const
				return c.body(null, status[result.reason])
			}
			const polar = createPolarCore({
				accessToken: c.var.config.POLAR_ACCESS_TOKEN,
				environment: c.var.config.POLAR_ENVIRONMENT,
			})
			c.executionCtx.waitUntil(
				recordSlateUsage(
					polar,
					{ id: result.slate.id, owner: getSlateOwner(result.slate) },
					"tool_call",
				),
			)
			return c.json(result.result, 200)
		},
	)
	api.route("/connections", personalConnections)
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
				403: { description: "This user cannot manage this Owner's connected accounts" },
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
			operationId: "connectAccount",
			path: "/connections/{type}/{owner_id}",
			request: {
				body: {
					content: { "application/json": { schema: connectAccountSchema } },
					required: true,
				},
				params: ownerParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: connectionLinkSchema } },
					description: "Composio link to connect an account for the selected Owner",
				},
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "This user cannot manage this Owner's connected accounts" },
			},
			security,
		}),
		async (c) => {
			const { owner_id, type } = c.req.valid("param")
			const result = await connectAccount(
				c.var.config,
				c.var.identity,
				{ id: owner_id, type },
				c.req.valid("json").toolkit,
			)
			if (!result.allowed) return c.body(null, 403)
			return c.json(result.link, 200)
		},
	)
	const slateOperations = new OpenAPIHono<OwnerViewingEnv>()
	slateOperations.use("*", requireAuth, requireSlateViewing)
	slateOperations.openapi(
		createRoute({
			method: "post",
			operationId: "joinSlate",
			path: "/join",
			request: { params: z.object({ target: slateTargetSchema }) },
			responses: {
				200: {
					content: { "application/json": { schema: slateMemberSchema } },
					description:
						"The authenticated user's slate membership, enabling unattended participation",
				},
				400: { description: "Invalid slate target" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Public slates cannot be joined, or private slate viewing is forbidden",
				},
				404: { description: "Slate not found" },
			},
			security,
		}),
		async (c) => {
			if (c.var.slateAccess.slate.visibility === "public") return c.body(null, 403)
			return c.json(
				await joinSlate(
					c.var.db,
					c.env.ARTIFACTS,
					c.env.DATABASES,
					c.env.AGENTS,
					c.var.slateAccess,
				),
				200,
			)
		},
	)
	slateOperations.openapi(
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
				400: { description: "Invalid slate target or agent name" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Only the Owner or owning organization members may inspect agent source",
				},
				404: { description: "Slate or agent instructions not found" },
			},
			security,
		}),
		async (c) => {
			const result = await getAgent(
				c.env.ARTIFACTS,
				c.var.slateAccess,
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
		// Public slates are temporarily excluded from jobs.
		if (c.var.slateAccess.slate.visibility === "public") return c.body(null, 403)
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
				400: { description: "Invalid slate target, agent name, or prompt" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Slate viewing is forbidden, the slate is public, or viewer resources require membership",
				},
				404: { description: "Slate or deployed agent not found" },
				409: {
					content: { "application/json": { schema: connectionRequiredSchema } },
					description:
						"The agent's declared connection needs a connected account assigned",
				},
			},
			security,
		}),
		async (c) => {
			const result = await startAgentJob(
				c.var.db,
				c.env.ARTIFACTS,
				c.env.AGENTS,
				c.var.slateAccess,
				{ ...c.req.valid("json"), name: c.req.valid("param").name },
			)
			if (!result.allowed) {
				if (result.reason === "connection-required")
					return c.json({ reason: result.reason, slug: result.slug }, 409)
				return c.body(null, result.reason === "membership-required" ? 403 : 404)
			}
			return c.json(result.job, 202)
		},
	)
	jobs.openapi(
		createRoute({
			method: "get",
			operationId: "getAgentJob",
			path: "/{id}",
			request: { params: agentJobParamsSchema, query: agentJobQuerySchema },
			responses: {
				200: {
					content: { "application/json": { schema: agentJobSchema } },
					description: "Native Think job status and saved assistant text result",
				},
				400: { description: "Invalid slate target, agent name, or job ID" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing is forbidden or the slate is public" },
				404: { description: "Slate or agent job not found" },
			},
			security,
		}),
		async (c) => {
			const { id, name } = c.req.valid("param")
			const job = await getAgentJob(
				c.env.AGENTS,
				c.var.slateAccess.slate,
				name,
				id,
				c.req.valid("query").instance_name,
			)
			if (!job) return c.body(null, 404)
			return c.json(job, 200)
		},
	)
	jobs.openapi(
		createRoute({
			method: "get",
			operationId: "listAgentJobs",
			path: "/",
			request: { params: agentParamsSchema },
			responses: {
				200: {
					content: {
						"application/json": { schema: z.object({ jobs: z.array(agentJobSchema) }) },
					},
					description:
						"App and signed-in user's agent jobs, including scheduled executions",
				},
				400: { description: "Invalid slate target or agent name" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing is forbidden or the slate is public" },
				404: { description: "Slate not found" },
			},
			security,
		}),
		async (c) =>
			c.json(
				{
					jobs: await listAgentJobs(
						c.env.AGENTS,
						c.var.slateAccess,
						c.req.valid("param").name,
					),
				},
				200,
			),
	)
	slateOperations.route("/agents/:name/jobs", jobs)
	slateOperations.openapi(
		createRoute({
			method: "patch",
			operationId: "updateSlateVisibility",
			path: "/",
			request: {
				body: {
					content: { "application/json": { schema: updateSlateVisibilityRequestSchema } },
					required: true,
				},
				params: z.object({ target: slateTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: slateSchema } },
					description: "Slate with its saved visibility",
				},
				400: { description: "Invalid slate target or visibility" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Only the Owner or owning organization members may update this slate",
				},
				404: { description: "Slate not found" },
			},
			security,
		}),
		async (c) => {
			const result = await updateSlateVisibility(
				c.var.db,
				c.var.slateAccess,
				c.var.config.CTX_AUTH_ISSUER,
				c.req.valid("json"),
			)
			if (!result.allowed) return c.body(null, 403)
			return c.json(result.slate, 200)
		},
	)
	const resourceOperations = new OpenAPIHono<
		OwnerViewingEnv & { Variables: { resources: Resources } }
	>({
		defaultHook: async (result, c) => {
			if (!result.success || result.target !== "json") return
			const snapshot = await getSlateResources(c.var.slateAccess, c.env.ARTIFACTS)
			if (!snapshot.allowed) return c.json({ reason: snapshot.reason }, 409)
			c.set("resources", snapshot.resources)
		},
	})
	resourceOperations.openapi(
		createRoute({
			method: "post",
			operationId: "listSlateResources",
			path: "/resources/list",
			request: {
				body: {
					content: { "application/json": { schema: slateResourcesRequestSchema } },
					required: true,
				},
				params: z.object({ target: slateTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: slateResourcesSchema } },
					description:
						"Resource requirements, consumers, selected Owners, and saved connection assignments",
				},
				400: { description: "Invalid listing request" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description: "Slate viewing is forbidden",
				},
				404: { description: "Slate not found" },
				409: noCommitResponse,
			},
			security,
		}),
		async (c) => {
			return c.json(
				await listSlateResources(c.var.db, c.var.slateAccess, c.var.resources),
				200,
			)
		},
	)
	resourceOperations.openapi(
		createRoute({
			method: "post",
			operationId: "listSlateConnections",
			path: "/connections/list",
			request: {
				body: {
					content: { "application/json": { schema: slateResourcesRequestSchema } },
					required: true,
				},
				params: z.object({ target: slateTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: slateConnectionsSchema } },
					description: "Slate requirements and connection assignments",
				},
				400: { description: "Invalid listing request" },
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: {
					description: "Slate viewing is forbidden",
				},
				404: { description: "Slate not found" },
				409: noCommitResponse,
			},
			security,
		}),
		async (c) => {
			const result = await listSlateConnections(
				c.var.db,
				c.var.slateAccess,
				c.var.resources,
			)
			return c.json(result, 200)
		},
	)
	resourceOperations.openapi(
		createRoute({
			method: "post",
			operationId: "assignSlateConnection",
			path: "/connections/assign",
			request: {
				body: {
					content: { "application/json": { schema: assignSlateConnectionRequestSchema } },
					required: true,
				},
				params: z.object({ target: slateTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: assignmentSchema } },
					description: "Saved viewer or owner connection assignment",
				},
				400: { description: "Invalid assignment" },
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "Slate viewing or Owner connection management is forbidden" },
				404: { description: "Slate or connection requirement not found" },
				409: noCommitResponse,
			},
			security,
		}),
		async (c) => {
			const result = await assignSlateConnection(
				c.var.db,
				c.var.slateAccess,
				c.var.config.CTX_AUTH_ISSUER,
				c.req.valid("json"),
				c.var.resources,
			)
			if (!result.allowed) return c.body(null, result.reason === "forbidden" ? 403 : 404)
			return c.json(result.assignment, 200)
		},
	)
	slateOperations.route("/", resourceOperations)
	api.route("/slates/:target", slateOperations)
	api.doc31("/openapi.json", {
		info: { title: "ContextLayer Platform", version: "0.1.0" },
		openapi: "3.1.0",
		servers: [{ url: "/api" }],
	})
	return api
}
