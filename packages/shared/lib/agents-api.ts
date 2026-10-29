import { createRoute, z } from "@hono/zod-openapi"
import {
	agentJobCreationSchema,
	agentJobEntrySchema,
	agentJobInspectionSchema,
	agentJobMessageSchema,
	agentJobOperationSchema,
	agentJobRequestSchema,
	agentJobResultSchema,
	agentJobSessionSchema,
	agentJobsQuerySchema,
	agentJobUsageSchema,
	agentRunRequestSchema,
	agentRuntimeScheduleSchema,
	agentSchema,
} from "@/lib/agents"
import { slateTargetSchema } from "@/lib/slates"
import { connectionRequiredSchema, secretRequiredSchema } from "@/lib/tools"

export const agentParamsSchema = z.object({
	name: agentRunRequestSchema.shape.name,
	target: slateTargetSchema,
})
export const agentScheduleParamsSchema = agentParamsSchema.extend({
	scheduleId: z.string().min(1).openapi({
		description: "Native provisioned schedule ID from the schedule listing.",
	}),
})
export const agentJobParamsSchema = agentParamsSchema.extend({
	id: agentJobEntrySchema.shape.id,
})
export const agentJobSessionParamsSchema = agentJobParamsSchema.extend({
	session: z
		.string()
		.refine((session) => Number.isSafeInteger(Number(session)) && Number(session) >= 1, {
			message: "Use a positive integer Pi session ID",
		}),
})

export const getAgentRoute = createRoute({
	description:
		"Read an authored agent definition from the selected stack's trusted source snapshot: the current startup working tree locally, or the latest commit on main when hosted. Hosted source inspection requires slate management permission.",
	method: "get",
	operationId: "getAgent",
	path: "/",
	request: {
		params: agentParamsSchema,
	},
	responses: {
		200: {
			content: { "application/json": { schema: agentSchema } },
			description: "The agent's instructions and selected source revision",
		},
		400: { description: "Invalid slate target or agent name" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted source inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or agent instructions not found" },
	},
	summary: "Read an agent's instructions from the selected source",
	tags: ["Agents"],
})

export const listAgentSchedulesRoute = createRoute({
	description:
		"Inspect native authored cron schedules in the selected stack's agent scopes. Hosted inspection requires slate management permission; local access uses the selected checkout's loopback stack. Edit schedule source and apply it through hosted Git deployment or local stack restart; framework lifecycle callbacks are excluded.",
	method: "get",
	operationId: "listAgentSchedules",
	path: "/schedules",
	request: { params: agentParamsSchema },
	responses: {
		200: {
			content: {
				"application/json": { schema: z.array(agentRuntimeScheduleSchema) },
			},
			description: "Native provisioned authored cron schedule records",
		},
		400: { description: "Invalid slate target or agent name" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted schedule inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate not found" },
	},
	summary: "List an agent's provisioned schedules",
	tags: ["Agents"],
})

export const getAgentScheduleRoute = createRoute({
	description:
		"Inspect one native authored schedule by scheduleId. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack.",
	method: "get",
	operationId: "getAgentSchedule",
	path: "/schedules/{scheduleId}",
	request: { params: agentScheduleParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: agentRuntimeScheduleSchema } },
			description: "Native provisioned authored cron schedule records",
		},
		400: { description: "Invalid slate target, agent name, or schedule ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted schedule inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or schedule not found" },
	},
	summary: "Get a provisioned agent schedule",
	tags: ["Agents"],
})

export const startAgentJobRoute = createRoute({
	description:
		"Start a fresh job using the selected stack's trusted source and acting scope. Local execution uses the startup working tree and app actor; hosted execution uses the latest definition on main and authenticated user on a private slate. Returns after admission with the catalog job and native execution receipt, without waiting for an answer.",
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
			content: { "application/json": { schema: agentJobCreationSchema } },
			description: "Native routed job and Pi submission receipt",
			headers: {
				Location: {
					description: "The created job resource",
					schema: { type: "string" },
				},
			},
		},
		400: { description: "Invalid slate target, agent name, or prompt" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description: "Hosted slate viewing is forbidden or the slate is public",
		},
		404: { description: "Slate or agent definition not found" },
		409: {
			content: {
				"application/json": {
					schema: z.union([connectionRequiredSchema, secretRequiredSchema]),
				},
			},
			description: "A required connection assignment or declared secret is missing",
		},
	},
	summary: "Start an agent job with a prompt",
	tags: ["Agent jobs"],
})

export const getAgentJobRoute = createRoute({
	description:
		"Read one native catalog entry by job ID. Use the operation and result endpoints for execution state.",
	method: "get",
	operationId: "getAgentJob",
	path: "/{id}",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: agentJobEntrySchema } },
			description: "Native job catalog entry with actor and trigger provenance",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: { description: "Hosted slate viewing is forbidden or the slate is public" },
		404: { description: "Slate or agent job not found" },
	},
	summary: "Get an agent job's catalog entry",
	tags: ["Agent jobs"],
})

export const getAgentJobOperationRoute = createRoute({
	description:
		"Inspect the admitted native operation without waiting, including pending or settled state. This response contains no transcript.",
	method: "get",
	operationId: "getAgentJobOperation",
	path: "/{id}/operation",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: agentJobOperationSchema } },
			description: "Native Pi pending operation or settled result without the transcript",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: { description: "Hosted slate viewing is forbidden or the slate is public" },
		404: { description: "Slate or agent job not found" },
	},
	summary: "Get an agent job's current operation",
	tags: ["Agent jobs"],
})

export const getAgentJobResultRoute = createRoute({
	description:
		"Wait for the admitted native operation to settle and return its native result without a transcript. Use sessions and messages for execution detail.",
	method: "get",
	operationId: "getAgentJobResult",
	path: "/{id}/result",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: agentJobResultSchema } },
			description: "Await the native Pi settled result without the transcript",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: { description: "Hosted slate viewing is forbidden or the slate is public" },
		404: { description: "Slate or agent job not found" },
	},
	summary: "Wait for an agent job's operation result",
	tags: ["Agent jobs"],
})

export const listAgentJobSessionsRoute = createRoute({
	description:
		"Enumerate native execution sessions within this job. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack. Use the returned IDs with this job's messages operation.",
	method: "get",
	operationId: "listAgentJobSessions",
	path: "/{id}/sessions",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: z.array(agentJobSessionSchema) } },
			description: "Native Pi sessions within this job",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted execution inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or agent job not found" },
	},
	summary: "List the execution sessions within an agent job",
	tags: ["Agent jobs"],
})

export const getAgentJobMessagesRoute = createRoute({
	description:
		"Read the active transcript of an existing session in this job. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack. Missing jobs or sessions return HTTP 404.",
	method: "get",
	operationId: "getAgentJobMessages",
	path: "/{id}/sessions/{session}/messages",
	request: { params: agentJobSessionParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: z.array(agentJobMessageSchema) } },
			description: "Native active transcript entries for this job session",
		},
		400: { description: "Invalid slate target, agent name, job ID, or session" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted execution inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate, agent job, or Pi session not found" },
	},
	summary: "Read the active transcript of an agent job session",
	tags: ["Agent jobs"],
})

export const getAgentJobUsageRoute = createRoute({
	description:
		"Read native model and tool usage buckets for the job. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack.",
	method: "get",
	operationId: "getAgentJobUsage",
	path: "/{id}/usage",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: agentJobUsageSchema } },
			description: "Native Pi model and tool usage across the job conversations",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted execution inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or agent job not found" },
	},
	summary: "Get model and tool usage for an agent job",
	tags: ["Agent jobs"],
})

export const getAgentJobInspectionRoute = createRoute({
	description:
		"Inspect live scheduling, unfinished tasks, and queued or placed submissions. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack.",
	method: "get",
	operationId: "getAgentJobInspection",
	path: "/{id}/inspection",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: agentJobInspectionSchema } },
			description: "Native Pi scheduling, live tasks, and unfinished submissions",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted execution inspection is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or agent job not found" },
	},
	summary: "Inspect an agent job's live execution state",
	tags: ["Agent jobs"],
})

export const abortAgentJobRoute = createRoute({
	description:
		"Abort the native pending operation and retain the job and execution records. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack. HTTP 200 contains the native boolean result, including false when nothing was aborted; a missing catalog entry returns HTTP 404.",
	method: "delete",
	operationId: "abortAgentJob",
	path: "/{id}/operation",
	request: { params: agentJobParamsSchema },
	responses: {
		200: {
			content: { "application/json": { schema: z.boolean() } },
			description: "Native Pi abort result; false when the operation is already settled",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted job management is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or agent job not found" },
	},
	summary: "Abort an agent job's pending operation",
	tags: ["Agent jobs"],
})

export const deleteAgentJobRoute = createRoute({
	description:
		"Delete an owned job catalog entry and its native execution state, releasing its computer. Hosted access requires slate management permission; local access uses the selected checkout's loopback stack. Deletion does not undo database writes or actions already performed by tools.",
	method: "delete",
	operationId: "deleteAgentJob",
	path: "/{id}",
	request: { params: agentJobParamsSchema },
	responses: {
		204: {
			description: "Job catalog entry and independent execution object deleted",
		},
		400: { description: "Invalid slate target, agent name, or job ID" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: {
			description:
				"Hosted job management is limited to the Owner or owning organization members",
		},
		404: { description: "Slate or agent job not found" },
	},
	summary: "Delete an agent job and its execution state",
	tags: ["Agent jobs"],
})

export const listAgentJobsRoute = createRoute({
	description:
		"List native catalog entries for this agent in the selected stack's scopes, newest first by creation time and ID. Hosted access selects the app and current-user scopes; local access selects the checkout's app scope.",
	method: "get",
	operationId: "listAgentJobs",
	path: "/",
	request: { params: agentParamsSchema, query: agentJobsQuerySchema },
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({ jobs: z.array(agentJobEntrySchema) }),
				},
			},
			description:
				"Native job catalog entries from the selected stack's agent scopes, merged newest first by createdAt (descending ID breaks ties). Execution state is available through individual job inspection.",
		},
		400: { description: "Invalid slate target or agent name" },
		401: { description: "Hosted access requires a valid ContextLayer login" },
		403: { description: "Hosted slate viewing is forbidden or the slate is public" },
		404: { description: "Slate not found" },
	},
	summary: "List an agent's jobs available to the caller",
	tags: ["Agent jobs"],
})
