import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { secretRequiredSchema } from "@usecontextlayer/shared/tools"
import {
	agentConversationParamsSchema,
	agentConversationSchema,
	agentConversationsPageQuerySchema,
	agentConversationsPageSchema,
	agentConversationViewSchema,
	agentCreateConversationParamsSchema,
	agentEntriesPageQuerySchema,
	agentEntriesPageSchema,
	agentInstanceParamsSchema,
	agentParamsSchema,
	agentRuntimeScheduleSchema,
	agentScheduleParamsSchema,
	agentSchema,
	agentSubmissionParamsSchema,
	agentSubmissionRequestSchema,
	agentSubmissionSchema,
	agentSubmitInputParamsSchema,
} from "@/agents.schema"
import {
	authorizeAgentConversationAccess,
	createAgentConversation,
	getAgent,
	getAgentConversation,
	getAgentSchedule,
	getAgentSubmission,
	listAgentConversations,
	listAgentEntries,
	listAgentSchedules,
	submitAgentInput,
} from "@/agents.server"
import { platformCredentialSecurity as security } from "@/auth.schema"
import type { PlatformCredential } from "@/auth.server"
import type { AuthenticatedViewingEnv } from "@/slates.middleware"
import { slateTargetSchema } from "@/slates.schema"
import { connectionRequiredSchema } from "@/tools.schema"

export function createAgentsApi(
	slateParams:
		| z.ZodObject<{ target: typeof slateTargetSchema }>
		| z.ZodObject<Record<never, never>> = z.object({ target: slateTargetSchema }),
) {
	const agentParams = agentParamsSchema.omit({ target: true }).extend(slateParams.shape)
	const agentInstanceParams = agentInstanceParamsSchema
		.omit({ target: true })
		.extend(slateParams.shape)
	const agentCreateConversationParams = agentCreateConversationParamsSchema
		.omit({ target: true })
		.extend(slateParams.shape)
	const agentSubmitInputParams = agentSubmitInputParamsSchema
		.omit({ target: true })
		.extend(slateParams.shape)
	const agentConversationParams = agentConversationParamsSchema
		.omit({ target: true })
		.extend(slateParams.shape)
	const agentSubmissionParams = agentSubmissionParamsSchema
		.omit({ target: true })
		.extend(slateParams.shape)
	const agentScheduleParams = agentScheduleParamsSchema
		.omit({ target: true })
		.extend(slateParams.shape)
	const agents = new OpenAPIHono<AuthenticatedViewingEnv<PlatformCredential>>()
	agents.openapi(
		createRoute({
			description:
				"Read an authored agent definition from the latest commit on main. Requires slate management permission because instructions are source.",
			method: "get",
			operationId: "getAgent",
			path: "/",
			request: {
				params: agentParams,
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
			summary: "Read an agent's instructions from the latest commit",
			tags: ["Agents"],
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
	const agentInstance = new OpenAPIHono<AuthenticatedViewingEnv<PlatformCredential>>()
	agentInstance.openapi(
		createRoute({
			description:
				"Inspect native authored cron schedules in the addressed user or app SlateAgent. Requires slate management permission, including for public slates. Schedule authoring and removal happen through Git and deployment; framework lifecycle callbacks are excluded.",
			method: "get",
			operationId: "listAgentSchedules",
			path: "/schedules",
			request: { params: agentInstanceParams },
			responses: {
				200: {
					content: {
						"application/json": { schema: z.array(agentRuntimeScheduleSchema) },
					},
					description: "Native provisioned authored cron schedule records",
				},
				400: { description: "Invalid slate target, agent name, or actor" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Only the Owner or owning organization members may inspect schedules",
				},
				404: { description: "Slate not found" },
			},
			security,
			summary: "List an agent's provisioned schedules",
			tags: ["Agents"],
		}),
		async (c) => {
			const params = c.req.valid("param")
			const result = await listAgentSchedules(
				c.env.AGENTS,
				c.var.slateAccess,
				c.var.config.CTX_AUTH_ISSUER,
				params.name,
				params.actor,
			)
			if (!result.allowed) {
				const status = { forbidden: 403, "sign-in-required": 401 } as const
				return c.body(null, status[result.reason])
			}

			return c.json(result.schedules, 200)
		},
	)
	agentInstance.openapi(
		createRoute({
			description:
				"Inspect one native authored schedule by scheduleId in the addressed user or app SlateAgent. Requires slate management permission, including for public slates.",
			method: "get",
			operationId: "getAgentSchedule",
			path: "/schedules/{scheduleId}",
			request: { params: agentScheduleParams },
			responses: {
				200: {
					content: { "application/json": { schema: agentRuntimeScheduleSchema } },
					description: "Native provisioned authored cron schedule records",
				},
				400: { description: "Invalid slate target, agent name, actor, or schedule ID" },
				401: { description: "A valid ContextLayer login is required" },
				403: {
					description:
						"Only the Owner or owning organization members may inspect schedules",
				},
				404: { description: "Slate or schedule not found" },
			},
			security,
			summary: "Get a provisioned agent schedule",
			tags: ["Agents"],
		}),
		async (c) => {
			const params = c.req.valid("param")
			const result = await getAgentSchedule(
				c.env.AGENTS,
				c.var.slateAccess,
				c.var.config.CTX_AUTH_ISSUER,
				params.name,
				params.actor,
				params.scheduleId,
			)
			if (!result.allowed) {
				const status = { forbidden: 403, "sign-in-required": 401 } as const
				return c.body(null, status[result.reason])
			}
			if (!result.schedule) return c.body(null, 404)
			return c.json(result.schedule, 200)
		},
	)

	const agentExecution = new OpenAPIHono<AuthenticatedViewingEnv<PlatformCredential>>()
	agentExecution.onError((error, c) => {
		// Durable Object RPC preserves error names, not custom class identity.
		if (error.name === "StorageRequestError") return c.text(error.message, 400)
		throw error
	})
	agentExecution.use("*", async (c, next) => {
		if (!authorizeAgentConversationAccess(c.var.slateAccess).allowed)
			return c.body(null, 403)
		await next()
	})
	agentExecution.openapi(
		createRoute({
			description:
				"Create a conversation for the authenticated user in this named agent's shared runtime. New conversations use the current model and creation defaults. Returns the native Pi conversation record.",
			method: "post",
			operationId: "createAgentConversation",
			path: "/conversations",
			request: { params: agentCreateConversationParams },
			responses: {
				201: {
					content: { "application/json": { schema: agentConversationSchema } },
					description: "The created native Pi conversation",
					headers: {
						Location: {
							description: "The created conversation resource",
							schema: { type: "string" },
						},
					},
				},
				400: { description: "Invalid slate target, agent name, or actor" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing is forbidden or the slate is public" },
				404: { description: "Slate or agent definition not found" },
				409: {
					content: {
						"application/json": {
							schema: z.union([connectionRequiredSchema, secretRequiredSchema]),
						},
					},
					description: "A required connection assignment or personal secret is missing",
				},
			},
			security,
			summary: "Create an agent conversation",
			tags: ["Agent conversations"],
		}),
		async (c) => {
			const { actor, name } = c.req.valid("param")
			const result = await createAgentConversation(
				c.var.db,
				c.env.ARTIFACTS,
				c.env.MEMBER_PROVISIONING,
				c.env.AGENTS,
				c.var.config,
				c.var.slateAccess,
				name,
				actor,
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
				`${new URL(c.req.url).pathname.replace(/\/$/, "")}/${result.conversation.id}`,
			)
			return c.json(result.conversation, 201)
		},
	)
	agentExecution.openapi(
		createRoute({
			description:
				"Submit native Pi input to an existing conversation belonging to the authenticated user. Returns the native submission record after durable admission; execution continues after disconnection. An optional requestId deduplicates input within this conversation.",
			method: "post",
			operationId: "submitAgentInput",
			path: "/conversations/{conversationId}/submissions",
			request: {
				body: {
					content: { "application/json": { schema: agentSubmissionRequestSchema } },
					required: true,
				},
				params: agentSubmitInputParams,
			},
			responses: {
				202: {
					content: { "application/json": { schema: agentSubmissionSchema } },
					description: "Native Pi submission with its durable ID and current status",
				},
				400: {
					description:
						"Invalid slate target, agent name, actor, conversation ID, or input",
				},
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing is forbidden or the slate is public" },
				404: { description: "Slate, agent definition, or conversation not found" },
				409: {
					content: {
						"application/json": {
							schema: z.union([connectionRequiredSchema, secretRequiredSchema]),
						},
					},
					description: "A required connection assignment or personal secret is missing",
				},
			},
			security,
			summary: "Submit input to an agent conversation",
			tags: ["Agent conversations"],
		}),
		async (c) => {
			const { actor, conversationId, name } = c.req.valid("param")
			const result = await submitAgentInput(
				c.var.db,
				c.env.ARTIFACTS,
				c.env.MEMBER_PROVISIONING,
				c.env.AGENTS,
				c.var.config,
				c.var.slateAccess,
				name,
				actor,
				conversationId,
				c.req.valid("json"),
			)
			if (!result.allowed) {
				if (result.reason === "secret-required")
					return c.json({ name: result.name, reason: result.reason }, 409)
				if (result.reason === "connection-required")
					return c.json({ reason: result.reason, slug: result.slug }, 409)
				return c.body(null, result.reason === "forbidden" ? 403 : 404)
			}
			return c.json(result.submission, 202)
		},
	)
	agentExecution.openapi(
		createRoute({
			description:
				"Read a native Pi submission in the selected user or app agent instance. A completed input's answer identifies its exact entry; retrieve it through listAgentEntries with equal minEntryId and maxEntryId and limit=1. This operation does not wait for completion.",
			method: "get",
			operationId: "getAgentSubmission",
			path: "/submissions/{submissionId}",
			request: {
				params: agentSubmissionParams,
			},
			responses: {
				200: {
					content: { "application/json": { schema: agentSubmissionSchema } },
					description: "Native Pi submission and its current outcome",
				},
				400: { description: "Invalid slate target, agent name, submission ID, or actor" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing is forbidden or the slate is public" },
				404: { description: "Slate or submission not found" },
			},
			security,
			summary: "Get an agent submission",
			tags: ["Agent conversations"],
		}),
		async (c) => {
			const { actor, name, submissionId } = c.req.valid("param")
			const submission = await getAgentSubmission(
				c.env.AGENTS,
				c.var.slateAccess,
				name,
				actor,
				submissionId,
			)
			if (!submission) return c.body(null, 404)
			return c.json(submission, 200)
		},
	)
	agentExecution.openapi(
		createRoute({
			description:
				"Page native Pi conversation records in the selected user or app agent instance. Native filters, IDs, and cursors apply within that one instance. The directory includes root and task-owned child conversations.",
			method: "get",
			operationId: "listAgentConversations",
			path: "/conversations",
			request: {
				params: agentInstanceParams,
				query: agentConversationsPageQuerySchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: agentConversationsPageSchema } },
					description: "A native Pi page of conversation records",
				},
				400: { description: "Invalid slate target, agent name, actor, or scan query" },
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate viewing is forbidden or the slate is public" },
				404: { description: "Slate not found" },
			},
			security,
			summary: "List an agent's conversations",
			tags: ["Agent conversations"],
		}),
		async (c) => {
			const { actor, name } = c.req.valid("param")
			const { cursor, limit, ...query } = c.req.valid("query")
			return c.json(
				await listAgentConversations(
					c.env.AGENTS,
					c.var.slateAccess,
					name,
					actor,
					query,
					limit,
					cursor,
				),
				200,
			)
		},
	)
	agentExecution.openapi(
		createRoute({
			description:
				"Inspect a native Pi conversation view in the selected user or app agent instance. Requires slate management permission because the view includes recent entries and internal documents, including rendered system instructions.",
			method: "get",
			operationId: "getAgentConversation",
			path: "/conversations/{conversationId}",
			request: {
				params: agentConversationParams,
			},
			responses: {
				200: {
					content: { "application/json": { schema: agentConversationViewSchema } },
					description:
						"Native Pi conversation view with recent history and current state",
				},
				400: {
					description: "Invalid slate target, agent name, conversation ID, or actor",
				},
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate management is forbidden or the slate is public" },
				404: { description: "Slate or conversation not found" },
			},
			security,
			summary: "Inspect an agent conversation",
			tags: ["Agent conversations"],
		}),
		async (c) => {
			const { actor, conversationId, name } = c.req.valid("param")
			const result = await getAgentConversation(
				c.env.AGENTS,
				c.var.slateAccess,
				c.var.config.CTX_AUTH_ISSUER,
				name,
				actor,
				conversationId,
			)
			if (!result.allowed) {
				const status = {
					forbidden: 403,
					"not-found": 404,
					"sign-in-required": 401,
				} as const
				return c.body(null, status[result.reason])
			}
			return c.json(result.conversation, 200)
		},
	)
	agentExecution.openapi(
		createRoute({
			description:
				"Page native Pi entries for a conversation in the selected user or app agent instance. Requires slate management permission. Entry bounds are inclusive; equal minEntryId and maxEntryId with limit=1 retrieves an exact answer. Preserve the selected actor when returning a native cursor.",
			method: "get",
			operationId: "listAgentEntries",
			path: "/conversations/{conversationId}/entries",
			request: {
				params: agentConversationParams,
				query: agentEntriesPageQuerySchema,
			},
			responses: {
				200: {
					content: { "application/json": { schema: agentEntriesPageSchema } },
					description: "A native Pi page of conversation entries",
				},
				400: {
					description:
						"Invalid slate target, agent name, actor, conversation ID, or scan query",
				},
				401: { description: "A valid ContextLayer login is required" },
				403: { description: "Slate management is forbidden or the slate is public" },
				404: { description: "Slate or conversation not found" },
			},
			security,
			summary: "Read an agent conversation's entries",
			tags: ["Agent conversations"],
		}),
		async (c) => {
			const { actor, conversationId, name } = c.req.valid("param")
			const { cursor, limit, ...query } = c.req.valid("query")
			const result = await listAgentEntries(
				c.env.AGENTS,
				c.var.slateAccess,
				c.var.config.CTX_AUTH_ISSUER,
				name,
				actor,
				conversationId,
				query,
				limit,
				cursor,
			)
			if (!result.allowed) {
				const status = {
					forbidden: 403,
					"not-found": 404,
					"sign-in-required": 401,
				} as const
				return c.body(null, status[result.reason])
			}
			return c.json(result.entries, 200)
		},
	)
	agentInstance.route("/", agentExecution)
	agents.route("/:actor", agentInstance)
	return agents
}
