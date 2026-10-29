import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi"
import { createPolarCore, webhooks } from "@polar-sh/sdk/2026-10"
import {
	abortAgentJobRoute,
	deleteAgentJobRoute,
	getAgentJobInspectionRoute,
	getAgentJobMessagesRoute,
	getAgentJobOperationRoute,
	getAgentJobResultRoute,
	getAgentJobRoute,
	getAgentJobUsageRoute,
	getAgentRoute,
	getAgentScheduleRoute,
	listAgentJobSessionsRoute,
	listAgentJobsRoute,
	listAgentSchedulesRoute,
	startAgentJobRoute,
} from "@usecontextlayer/shared/agents-api"
import { noCommitSchema } from "@usecontextlayer/shared/slate-resources"
import {
	recordSlateUsage,
	resolvedSlateSchema,
} from "@usecontextlayer/shared/slate-usage"
import { isAPIError } from "better-auth/api"
import {
	accountLinkSchema,
	accountsSchema,
	connectAccountSchema,
	personalAccountsQuerySchema,
} from "@/accounts.schema"
import { connectAccount, listAccounts, listPersonalAccounts } from "@/accounts.server"
import {
	abortAgentJob,
	deleteAgentJob,
	getAgent,
	getAgentJob,
	getAgentJobInspection,
	getAgentJobMessages,
	getAgentJobOperation,
	getAgentJobResult,
	getAgentJobUsage,
	getAgentSchedule,
	listAgentJobSessions,
	listAgentJobs,
	listAgentSchedules,
	startAgentJob,
} from "@/agents.server"
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
import { createInspectionApi } from "@/inspection.api"
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
import type { SlateDeclarationSnapshot } from "@/slate-declarations.server"
import {
	listSlateConnections,
	listSlateResources,
} from "@/slate-resource-configuration.server"
import { getSlateResources } from "@/slate-resource-execution.server"
import {
	slateResourcesRequestSchema,
	slateResourcesSchema,
} from "@/slate-resources.schema"
import { setSlateSecret } from "@/slate-secrets.server"
import {
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
	accountSessionToolSchema,
	accountSessionToolsSchema,
	accountToolCallSchema,
	accountToolParamsSchema,
	accountToolResultSchema,
	accountToolSessionParamsSchema,
	accountToolSessionRequestSchema,
	accountToolSessionSchema,
} from "@/tools.schema"
import {
	callAccountTool,
	callPersonalAccountSessionTool,
	createPersonalAccountToolSession,
	listPersonalAccountSessionTools,
} from "@/tools.server"

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
	api.openAPIRegistry.registerComponent(
		"schemas",
		"ComposioTool",
		accountSessionToolSchema,
	)
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
	const slateRouting = new OpenAPIHono<IdentityEnv>()
	slateRouting.openapi(
		createRoute({
			description:
				"Resolve a public hostname to a slate authorized for this caller. Private slates require the owning user or an organization member. The pathname identifies the requested slate path.",
			method: "get",
			operationId: "resolveSlate",
			path: "/resolve",
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
			summary: "Resolve a slate hostname for authorized viewing",
			tags: ["Slate routing"],
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
			const billing = await checkSlateBilling(c.var.db, c.var.config, result.slate)
			if (!billing.allowed) return c.text(billing.message, 402)
			return c.json({ id: result.slate.id, owner: getSlateOwner(result.slate) }, 200)
		},
	)
	slateRouting.openapi(
		createRoute({
			description:
				"Read public OAuth protected-resource metadata for a slate MCP endpoint. This does not grant access to the slate or its resources.",
			method: "get",
			operationId: "getSlateMcpMetadata",
			path: "/mcp/metadata",
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
			summary: "Get OAuth metadata for a slate MCP endpoint",
			tags: ["Slate routing"],
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
	api.route("/slates", slateRouting)
	api.use("*", identifyUser, requireCsrf)
	api.route("/slates", createInspectionApi())

	const slates = new OpenAPIHono<OwnerAuthenticatedEnv>()
	slates.use("*", requireAuth)
	slates.openapi(
		createRoute({
			description:
				"List manageable slates, including slates belonging to the authenticated user and their organizations. Supply either owner_user_id or owner_organization_id, or omit both to list all manageable slates. Filters do not grant access to another Owner.",
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
			summary: "List slates the caller can manage",
			tags: ["Slates"],
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
	slates.openapi(
		createRoute({
			description:
				"Create a private slate and its source repository. Omitting organization_slug uses the authenticated personal Owner; supplying it selects an organization the caller belongs to.",
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
			summary: "Create a slate for a personal or organization Owner",
			tags: ["Slates"],
		}),
		async (c) => {
			const slate = await createSlate(
				c.var.db,
				c.env.ARTIFACTS,
				c.var.config,
				c.var.identity,
				c.req.valid("json"),
			)
			if (!slate) return c.body(null, 404)
			return c.json(slate, 201)
		},
	)
	slates.openapi(
		createRoute({
			description:
				"Read the canonical slate identity and visibility using a SlateID or public hostname. Requires slate management permission.",
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
			summary: "Get a slate the caller can manage",
			tags: ["Slates"],
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
	const slate = new OpenAPIHono<OwnerViewingEnv>()
	slate.use("*", requireSlateViewing)
	slate.openapi(
		createRoute({
			description:
				"Change the slate between public and private viewing. Requires slate management permission; visibility does not change source-management authority or resource ownership.",
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
			summary: "Update who can view a slate",
			tags: ["Slates"],
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

	const slateResources = new OpenAPIHono<
		OwnerViewingEnv & { Variables: { snapshot: SlateDeclarationSnapshot } }
	>({
		defaultHook: async (result, c) => {
			if (!result.success || result.target !== "json") return
			const snapshot = await getSlateResources(c.var.slateAccess, c.env.ARTIFACTS)
			if (!snapshot.allowed) return c.json({ reason: snapshot.reason }, 409)
			c.set("snapshot", snapshot)
		},
	})
	slateResources.openapi(
		createRoute({
			description:
				"Read requirements from the pushed app and agent declarations together with their hosted configuration. This inventory does not execute resources or return secret values.",
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
						"Resource requirements, consumers, selected Owners, saved connection assignments, and secret presence",
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
			summary: "List declared resources and their configuration",
			tags: ["Slate resources"],
		}),
		async (c) => {
			return c.json(
				await listSlateResources(
					c.var.db,
					c.var.config,
					c.var.slateAccess,
					c.var.snapshot.resources,
				),
				200,
			)
		},
	)
	slateResources.openapi(
		createRoute({
			description:
				"Read pushed connection requirements and hosted account assignments. Local checkout assignments are independent and are not uploaded to this configuration.",
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
			summary: "List declared connections and their account assignments",
			tags: ["Slate resources"],
		}),
		async (c) => {
			const result = await listSlateConnections(
				c.var.db,
				c.var.config,
				c.var.slateAccess,
				c.var.snapshot.resources,
			)
			return c.json(result, 200)
		},
	)
	slateResources.openapi(
		createRoute({
			description:
				"Assign an existing connected account to a pushed connection requirement for its declared Owner. The account must match the declared toolkit. This does not create an account or perform provider authorization.",
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
				403: { description: "Slate viewing or Owner account management is forbidden" },
				404: { description: "Slate or connection requirement not found" },
				409: noCommitResponse,
			},
			security,
			summary: "Assign an account to a declared connection",
			tags: ["Slate resources"],
		}),
		async (c) => {
			const result = await assignSlateConnection(
				c.var.db,
				c.env.MEMBER_PROVISIONING,
				c.var.config,
				c.var.slateAccess,
				c.req.valid("json"),
				c.var.snapshot,
			)
			if (!result.allowed) return c.body(null, result.reason === "forbidden" ? 403 : 404)
			return c.json(result.assignment, 200)
		},
	)
	slateResources.openapi(
		createRoute({
			description:
				"Save the named secret for the Owner selected by its pushed requirement and mode. Supply secret values directly; responses do not return stored values.",
			method: "put",
			operationId: "setSlateSecret",
			path: "/secrets/{name}",
			request: {
				body: {
					content: { "application/json": { schema: setSecretRequestSchema } },
					required: true,
				},
				params: z.object({ name: secretSchema.shape.name, target: slateTargetSchema }),
			},
			responses: {
				200: {
					content: { "application/json": { schema: secretSchema } },
					description: "Saved secret's Owner and name; completes slate setup when ready",
				},
				400: { description: "Invalid secret name or value" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing or secret Owner management is forbidden" },
				404: { description: "Slate or secret requirement not found" },
				409: noCommitResponse,
			},
			security,
			summary: "Set a declared secret for its selected Owner",
			tags: ["Slate resources"],
		}),
		async (c) => {
			const result = await setSlateSecret(
				c.var.db,
				c.env.MEMBER_PROVISIONING,
				c.env.MERIDIAN,
				c.var.config,
				c.var.slateAccess,
				c.req.valid("param").name,
				c.req.valid("json"),
				c.var.snapshot,
			)
			if (!result.allowed) return c.body(null, result.reason === "forbidden" ? 403 : 404)
			return c.json(result.secret, 200)
		},
	)
	slate.route("/", slateResources)

	const agents = new OpenAPIHono<OwnerViewingEnv>()
	agents.openapi({ ...getAgentRoute, security }, async (c) => {
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
	})
	agents.openapi({ ...listAgentSchedulesRoute, security }, async (c) => {
		const params = c.req.valid("param")
		const result = await listAgentSchedules(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			params.name,
		)
		if (!result.allowed) {
			const status = { forbidden: 403, "sign-in-required": 401 } as const
			return c.body(null, status[result.reason])
		}

		return c.json(result.schedules, 200)
	})
	agents.openapi({ ...getAgentScheduleRoute, security }, async (c) => {
		const params = c.req.valid("param")
		const result = await getAgentSchedule(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			params.name,
			params.scheduleId,
		)
		if (!result.allowed) {
			const status = { forbidden: 403, "sign-in-required": 401 } as const
			return c.body(null, status[result.reason])
		}
		if (!result.schedule) return c.body(null, 404)
		return c.json(result.schedule, 200)
	})

	const jobs = new OpenAPIHono<OwnerViewingEnv>()
	jobs.use("*", async (c, next) => {
		// Public slates are temporarily excluded from jobs.
		if (c.var.slateAccess.slate.visibility === "public") return c.body(null, 403)
		await next()
	})
	jobs.openapi({ ...startAgentJobRoute, security }, async (c) => {
		const result = await startAgentJob(
			c.var.db,
			c.env.ARTIFACTS,
			c.env.MEMBER_PROVISIONING,
			c.env.AGENTS,
			c.var.config,
			c.var.slateAccess,
			{ ...c.req.valid("json"), name: c.req.valid("param").name },
		)
		if (!result.allowed) {
			if (result.reason === "secret-required")
				return c.json({ name: result.name, reason: result.reason }, 409)
			if (result.reason === "connection-required")
				return c.json({ reason: result.reason, slug: result.slug }, 409)
			return c.body(null, result.reason === "forbidden" ? 403 : 404)
		}
		c.header(
			"Location",
			`${new URL(c.req.url).pathname.replace(/\/$/, "")}/${result.creation.job.id}`,
		)
		return c.json(result.creation, 202)
	})
	jobs.openapi({ ...getAgentJobRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const job = await getAgentJob(c.env.AGENTS, c.var.slateAccess, name, id)
		if (!job) return c.body(null, 404)
		return c.json(job, 200)
	})
	jobs.openapi({ ...getAgentJobOperationRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const operation = await getAgentJobOperation(
			c.env.AGENTS,
			c.var.slateAccess,
			name,
			id,
		)
		if (!operation) return c.body(null, 404)
		return c.json(operation, 200)
	})
	jobs.openapi({ ...getAgentJobResultRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const operation = await getAgentJobResult(c.env.AGENTS, c.var.slateAccess, name, id)
		if (!operation) return c.body(null, 404)
		return c.json(operation, 200)
	})
	jobs.openapi({ ...listAgentJobSessionsRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const result = await listAgentJobSessions(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			name,
			id,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			return c.body(null, status[result.reason])
		}
		return c.json(result.sessions, 200)
	})
	jobs.openapi({ ...getAgentJobMessagesRoute, security }, async (c) => {
		const { id, name, session } = c.req.valid("param")
		const result = await getAgentJobMessages(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			name,
			id,
			session,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			return c.body(null, status[result.reason])
		}
		return c.json(result.messages, 200)
	})
	jobs.openapi({ ...getAgentJobUsageRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const result = await getAgentJobUsage(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			name,
			id,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			return c.body(null, status[result.reason])
		}
		return c.json(result.usage, 200)
	})
	jobs.openapi({ ...getAgentJobInspectionRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const result = await getAgentJobInspection(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			name,
			id,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			return c.body(null, status[result.reason])
		}
		return c.json(result.inspection, 200)
	})
	jobs.openapi({ ...abortAgentJobRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const result = await abortAgentJob(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			name,
			id,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			return c.body(null, status[result.reason])
		}
		return c.json(result.result, 200)
	})
	jobs.openapi({ ...deleteAgentJobRoute, security }, async (c) => {
		const { id, name } = c.req.valid("param")
		const result = await deleteAgentJob(
			c.env.AGENTS,
			c.var.slateAccess,
			c.var.config.CTX_AUTH_ISSUER,
			name,
			id,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			return c.body(null, status[result.reason])
		}
		return c.body(null, 204)
	})
	jobs.openapi({ ...listAgentJobsRoute, security }, async (c) =>
		c.json(
			{
				jobs: await listAgentJobs(
					c.env.AGENTS,
					c.var.slateAccess,
					c.req.valid("param").name,
					c.req.valid("query").schedule,
				),
			},
			200,
		),
	)
	agents.route("/jobs", jobs)
	slate.route("/agents/:name", agents)
	slates.route("/:target", slate)
	api.route("/slates", slates)

	const accounts = new OpenAPIHono<OwnerAuthenticatedEnv>()
	accounts.use("*", requireAuth)
	accounts.openapi(
		createRoute({
			description:
				"List the authenticated developer personal ACTIVE connected accounts for the declared toolkit. This discovery does not include organization accounts or grant authority to execute arbitrary account tools.",
			method: "get",
			operationId: "listPersonalAccounts",
			path: "/",
			request: { query: personalAccountsQuerySchema },
			responses: {
				200: {
					content: { "application/json": { schema: accountsSchema } },
					description:
						"The signed-in user's connected accounts for the requested toolkit",
				},
				400: { description: "A toolkit is required; Owner selectors are not accepted" },
				401: {
					description: "A native web session or ContextLayer access token is required",
				},
			},
			security,
			summary: "List the caller's active accounts for a toolkit",
			tags: ["Accounts"],
		}),
		async (c) => {
			const result = await listPersonalAccounts(
				c.var.config,
				c.var.identity,
				c.req.valid("query").toolkit,
			)
			return c.json(result, 200)
		},
	)

	accounts.openapi(
		createRoute({
			description:
				"Create a native Composio session pinned to the signed-in developer's personal ACTIVE account and requested toolkit. Requires management and billing admission for the canonical slate. Session creation does not execute a tool or record tool usage.",
			method: "post",
			operationId: "createPersonalAccountToolSession",
			path: "/{account_id}/sessions",
			request: {
				body: {
					content: { "application/json": { schema: accountToolSessionRequestSchema } },
					required: true,
				},
				params: accountToolParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: accountToolSessionSchema } },
					description: "Create a personal account tool session",
				},
				400: { description: "Invalid account, session, or toolkit request" },
				401: {
					description: "A native web session or ContextLayer access token is required",
				},
				402: {
					content: { "text/plain": { schema: z.string() } },
					description: "The slate Owner needs a plan or has exhausted their Free clips",
				},
				403: {
					description:
						"Slate management or personal account/session authority is forbidden",
				},
				404: { description: "Slate not found" },
			},
			security,
			summary: "Create a personal account tool session",
			tags: ["Accounts"],
		}),
		async (c) => {
			const result = await createPersonalAccountToolSession(
				c.var.db,
				c.var.config,
				c.var.identity,
				c.req.valid("param").account_id,
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

			return c.json({ session_id: result.session.sessionId }, 200)
		},
	)

	accounts.openapi(
		createRoute({
			description:
				"Read native Composio tools from an existing personal account session. Revalidates the signed-in user, ACTIVE account, toolkit pinning, and slate management/billing before reading the catalog. Metadata discovery does not record tool usage.",
			method: "get",
			operationId: "listPersonalAccountSessionTools",
			path: "/{account_id}/sessions/{session_id}/tools",
			request: {
				params: accountToolSessionParamsSchema,
				query: accountToolSessionRequestSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: accountSessionToolsSchema } },
					description: "List a personal account session's tools",
				},
				400: { description: "Invalid account, session, or toolkit request" },
				401: {
					description: "A native web session or ContextLayer access token is required",
				},
				402: {
					content: { "text/plain": { schema: z.string() } },
					description: "The slate Owner needs a plan or has exhausted their Free clips",
				},
				403: {
					description:
						"Slate management or personal account/session authority is forbidden",
				},
				404: { description: "Slate not found" },
			},
			security,
			summary: "List a personal account session's tools",
			tags: ["Accounts"],
		}),
		async (c) => {
			const result = await listPersonalAccountSessionTools(
				c.var.db,
				c.var.config,
				c.var.identity,
				c.req.valid("param").account_id,
				c.req.valid("param").session_id,
				c.req.valid("query"),
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

			return c.json(result.tools, 200)
		},
	)

	accounts.openapi(
		createRoute({
			description:
				"Execute a provider action in the same personal account session used for discovery. Revalidates native session configuration against the signed-in user, selected account and toolkit, with slate management and billing admission. Preserves the native Composio result including error, logId and data; provider execution records one tool call even when its result contains an error.",
			method: "post",
			operationId: "callPersonalAccountSessionTool",
			path: "/{account_id}/sessions/{session_id}/tools/call",
			request: {
				body: {
					content: { "application/json": { schema: accountToolCallSchema } },
					required: true,
				},
				params: accountToolSessionParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: accountToolResultSchema } },
					description: "Call a tool in a personal account session",
				},
				400: { description: "Invalid account, session, or toolkit request" },
				401: {
					description: "A native web session or ContextLayer access token is required",
				},
				402: {
					content: { "text/plain": { schema: z.string() } },
					description: "The slate Owner needs a plan or has exhausted their Free clips",
				},
				403: {
					description:
						"Slate management or personal account/session authority is forbidden",
				},
				404: { description: "Slate not found" },
			},
			security,
			summary: "Call a tool in a personal account session",
			tags: ["Accounts"],
		}),
		async (c) => {
			const result = await callPersonalAccountSessionTool(
				c.var.db,
				c.var.config,
				c.var.identity,
				c.req.valid("param").account_id,
				c.req.valid("param").session_id,
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
	accounts.openapi(
		createRoute({
			description:
				"Call a provider action through the authenticated developer personal connected account and the authorized slate. Preserve the provider result and error fields; HTTP success does not imply the provider action succeeded.",
			method: "post",
			operationId: "callAccountTool",
			path: "/{account_id}/tools/call",
			request: {
				body: {
					content: { "application/json": { schema: accountToolCallSchema } },
					required: true,
				},
				params: accountToolParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: accountToolResultSchema } },
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
			summary: "Call a tool with the caller's selected account",
			tags: ["Accounts"],
		}),
		async (c) => {
			const result = await callAccountTool(
				c.var.db,
				c.var.config,
				c.var.identity,
				c.req.valid("param").account_id,
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
	accounts.openapi(
		createRoute({
			description:
				"List ACTIVE connected accounts belonging to the selected personal or organization Owner. The caller must be that personal user or a member of the organization. Provider credentials remain in Composio.",
			method: "get",
			operationId: "listAccounts",
			path: "/{type}/{owner_id}",
			request: { params: ownerParamsSchema },
			responses: {
				200: {
					content: { "application/json": { schema: accountsSchema } },
					description: "Connected accounts belonging to the selected Owner",
				},
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "This user cannot manage this Owner's connected accounts" },
			},
			security,
			summary: "List active accounts belonging to an Owner",
			tags: ["Accounts"],
		}),
		async (c) => {
			const { owner_id, type } = c.req.valid("param")
			const result = await listAccounts(c.var.config, c.var.identity, {
				id: owner_id,
				type,
			})
			if (!result.allowed) return c.body(null, 403)
			return c.json({ accounts: result.accounts }, 200)
		},
	)
	accounts.openapi(
		createRoute({
			description:
				"Create a provider authorization link for the selected personal or organization Owner. The person completing the hosted OAuth flow chooses and authorizes the external account. The link is not a completed connection.",
			method: "post",
			operationId: "connectAccount",
			path: "/{type}/{owner_id}",
			request: {
				body: {
					content: { "application/json": { schema: connectAccountSchema } },
					required: true,
				},
				params: ownerParamsSchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: accountLinkSchema } },
					description: "Composio link to connect an account for the selected Owner",
				},
				401: {
					description: "A valid ContextLayer login is required",
				},
				403: { description: "This user cannot manage this Owner's connected accounts" },
			},
			security,
			summary: "Create an authorization link to connect an Owner's account",
			tags: ["Accounts"],
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
	api.route("/accounts", accounts)

	const secrets = new OpenAPIHono<OwnerAuthenticatedEnv>()
	secrets.use("*", requireAuth)
	secrets.openapi(
		createRoute({
			description:
				"Save a named secret for the selected personal or organization Owner after Owner authorization. The stored value is used by declarations resolving to that Owner and is not returned.",
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
			summary: "Set a named secret belonging to an Owner",
			tags: ["Shared secrets"],
		}),
		async (c) => {
			const { name, owner_id, type } = c.req.valid("param")
			const result = await setSharedSecret(
				c.env.MERIDIAN,
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
			description:
				"Delete a named secret for the selected personal or organization Owner after Owner authorization. Declarations remain unchanged and subsequently require the missing value.",
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
			summary: "Delete a named secret belonging to an Owner",
			tags: ["Shared secrets"],
		}),
		async (c) => {
			const { name, owner_id, type } = c.req.valid("param")
			const result = await dropSharedSecret(
				c.env.MERIDIAN,
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

	api.doc31("/openapi.json", (c) => ({
		info: { title: "ContextLayer Platform", version: "0.1.0" },
		openapi: "3.1.0",
		servers: [{ url: new URL("/api", c.req.url).href }],
		tags: [
			{ name: "Slates" },
			{ name: "Slate routing" },
			{ name: "Slate resources" },
			{ name: "Accounts" },
			{ name: "Shared secrets" },
			{ name: "Agents" },
			{ name: "Agent jobs" },
		],
	}))
	return api
}
