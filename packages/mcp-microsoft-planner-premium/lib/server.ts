// Microsoft owns the entity fields, OData bindings and action parameters exposed
// here. The HTTP entrypoint supplies a request-scoped Dataverse client; this file
// validates supported native payloads and supplies MCP descriptions and results.
// Operation-set sequencing belongs to operation-set.ts, HTTP to schedule-api.ts.

import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
	MAX_WAIT_SECONDS,
	OperationSetSubmissionError,
	submitOperationSet,
	waitForOperationSet,
} from "@/lib/operation-set"
import {
	retrieveRecordsSchema,
	type ScheduleApiClient,
	type StagedWrite,
} from "@/lib/schedule-api"
import packageJson from "@/package.json"

const MAX_OPERATIONS = 200

// Dataverse GUIDs can contain a non-version nibble (…-f011-…); uuid() rejects
// those real IDs. guid() enforces Microsoft's 8-4-4-4-12 shape without that rule.
const guid = z.guid()
// Input transforms generate IDs without advertising a fixed JSON Schema default.
const createId = guid.optional().transform((value) => value ?? randomUUID())
const binding = (entitySet: string) => z.templateLiteral([`/${entitySet}(`, guid, ")"])

// Same-call refs are package metadata, not Dataverse columns. Native binding
// strings pass through; a ref is resolved to one before anything reaches Microsoft.
const pending = z.strictObject({ ref: z.string().min(1) })
const taskBinding = z.union([binding("msdyn_projecttasks"), pending])
const bucketBinding = z.union([binding("msdyn_projectbuckets"), pending])
const ref = z.string().min(1).optional()

// Date-only input is interpreted at midnight and can land on the previous working day.
const instant = z.iso
	.datetime()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
		"must be a full UTC timestamp like 2026-08-28T17:00:00Z — a bare date is read as midnight and lands on the previous working day",
	)

const taskFields = z.strictObject({
	msdyn_description: z.string().optional().describe("Body text for the task"),
	msdyn_finish: instant.optional().describe("When the task is due"),
	msdyn_priority: z
		.number()
		.int()
		.min(0)
		.max(10)
		.optional()
		.describe("0-10; 5 is the default"),
	msdyn_start: instant.optional().describe("When work on the task starts"),
	msdyn_subject: z.string().min(1).describe("The task's name"),
})

const taskCreate = taskFields.extend({
	"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projecttask"),
	msdyn_outlinelevel: z
		.number()
		.int()
		.min(1)
		.default(1)
		.describe(
			"1 for a top-level task. A subtask is its parent's msdyn_outlinelevel plus one.",
		),
	"msdyn_parenttask@odata.bind": taskBinding.optional(),
	"msdyn_project@odata.bind": binding("msdyn_projects"),
	"msdyn_projectbucket@odata.bind": bucketBinding,
	msdyn_projecttaskid: createId,
	ref,
})

// Display order is unsupported: the recorder's create/update probes establish
// that the scheduling service does not honor it.
const bucketCreate = z.strictObject({
	"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projectbucket"),
	msdyn_name: z.string().min(1),
	"msdyn_project@odata.bind": binding("msdyn_projects"),
	msdyn_projectbucketid: createId,
	ref,
})

const taskLabelCreate = z.strictObject({
	"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projecttasktolabel"),
	// Labels already exist on the project; only the task may be a same-call ref.
	"msdyn_ProjectLabelId@odata.bind": binding("msdyn_projectlabels"),
	"msdyn_ProjectTaskId@odata.bind": taskBinding,
	msdyn_projecttasktolabelid: createId,
})

const assignmentCreate = z.strictObject({
	"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_resourceassignment"),
	msdyn_name: z.string().min(1),
	"msdyn_projectid@odata.bind": binding("msdyn_projects"),
	// An assignment names membership in this project, not a user or bookable resource.
	"msdyn_projectteamid@odata.bind": binding("msdyn_projectteams"),
	msdyn_resourceassignmentid: createId,
	"msdyn_taskid@odata.bind": taskBinding.describe(
		"The task to assign. The service refuses assignments to tasks that have subtasks.",
	),
})

const taskUpdate = taskFields
	.partial()
	.extend({
		"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projecttask"),
		msdyn_duration: z
			.number()
			.optional()
			.describe("Working days. Writing this moves the finish."),
		msdyn_effort: z.number().optional().describe("Hours of work"),
		"msdyn_parenttask@odata.bind": taskBinding.optional(),
		msdyn_progress: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe(
				"Fraction complete, 0-1 — 0.55 is 55%, and 1 is done. NOT a percentage: 55 is rejected.",
			),
		"msdyn_projectbucket@odata.bind": bucketBinding.optional(),
		msdyn_projecttaskid: z.union([guid, pending]),
	})
	.refine(
		(input) =>
			Object.keys(input).some(
				(field) => field !== "@odata.type" && field !== "msdyn_projecttaskid",
			),
		{ message: "Nothing to update — a task update needs at least one changed field." },
	)

const bucketUpdate = z.strictObject({
	"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projectbucket"),
	msdyn_name: z.string().min(1),
	msdyn_projectbucketid: z.union([guid, pending]),
})

// Color is unsupported by the recorded scheduling API. An empty label text is
// supported and retires the label; do not apply task/bucket nonempty-name rules.
const labelUpdate = z.strictObject({
	"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projectlabel"),
	msdyn_projectlabelid: guid,
	msdyn_projectlabeltext: z.string(),
})

// Deleting a bucket also deletes its tasks, which the permission prompt cannot
// disclose. Only the existing supported deletion types are exposed.
const deleteOperationSchema = z.discriminatedUnion("@odata.type", [
	z.strictObject({
		"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projecttask"),
		msdyn_projecttaskid: guid,
	}),
	z.strictObject({
		"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_projecttasktolabel"),
		msdyn_projecttasktolabelid: guid,
	}),
	z.strictObject({
		"@odata.type": z.literal("Microsoft.Dynamics.CRM.msdyn_resourceassignment"),
		msdyn_resourceassignmentid: guid,
	}),
])

const createOperationSchema = z.discriminatedUnion("@odata.type", [
	taskCreate,
	bucketCreate,
	taskLabelCreate,
	assignmentCreate,
])
const updateOperationSchema = z.discriminatedUnion("@odata.type", [
	taskUpdate,
	bucketUpdate,
	labelUpdate,
])

const submissionSchema = z
	.strictObject({
		creates: z
			.array(createOperationSchema)
			.default([])
			.describe("Native entities to create"),
		Description: z
			.string()
			.min(1)
			.describe("What this set does, in the words of the person approving it"),
		deletes: z
			.array(deleteOperationSchema)
			.default([])
			.describe("Native entity identities to remove; bucket deletion is not exposed"),
		ProjectId: guid.describe(
			"The project's msdyn_projectid, returned by retrieve_records on msdyn_projects",
		),
		updates: z
			.array(updateOperationSchema)
			.default([])
			.describe("Native entities containing only the fields to change"),
	})
	// An empty set is rejected at execute but stranded open against the ten-set
	// quota, with no API to find it again. Refuse it before minting a set.
	.refine(
		(input) => input.creates.length + input.updates.length + input.deletes.length > 0,
		{ message: "Nothing to do — a set needs at least one create, update or delete." },
	)
	.refine(
		(input) =>
			input.creates.length + input.updates.length + input.deletes.length <=
			MAX_OPERATIONS,
		{ message: `An operation set carries at most ${MAX_OPERATIONS} operations.` },
	)
	// The service accepts inverted dates but silently recomputes a different
	// schedule. Parsed instants also compare variable-width fractional seconds correctly.
	.refine(
		(input) =>
			[...input.creates, ...input.updates].every((entity) => {
				if (entity["@odata.type"] !== "Microsoft.Dynamics.CRM.msdyn_projecttask")
					return true
				return (
					entity.msdyn_start === undefined ||
					entity.msdyn_finish === undefined ||
					Date.parse(entity.msdyn_start) <= Date.parse(entity.msdyn_finish)
				)
			}),
		{
			message:
				"msdyn_finish is before msdyn_start — the service accepts this, silently recomputes the finish from the duration, and still reports the set completed, so the project would end up holding dates you did not send",
		},
	)

type Submission = z.output<typeof submissionSchema>
type CreatedReference = z.output<typeof taskCreate> | z.output<typeof bucketCreate>
type Operation =
	| Submission["creates"][number]
	| Submission["updates"][number]
	| Submission["deletes"][number]

function collectReferences(
	creates: Submission["creates"],
): Map<string, CreatedReference> {
	const references = new Map<string, CreatedReference>()
	for (const entity of creates) {
		if ("ref" in entity && entity.ref !== undefined) {
			if (references.has(entity.ref))
				throw new Error(
					`Two creates in this submission share the ref '${entity.ref}' — a ref names exactly one record.`,
				)
			references.set(entity.ref, entity)
		}
	}
	return references
}

function resolveReference(
	field: string,
	reference: z.output<typeof pending>,
	references: Map<string, CreatedReference>,
): string {
	const entity = references.get(reference.ref)
	if (entity === undefined)
		throw new Error(
			`Nothing in this submission is created with the ref '${reference.ref}'. A ref must name a create in the same call.`,
		)
	const expectedType =
		field === "msdyn_projectbucket@odata.bind" || field === "msdyn_projectbucketid"
			? "Microsoft.Dynamics.CRM.msdyn_projectbucket"
			: "Microsoft.Dynamics.CRM.msdyn_projecttask"
	if (entity["@odata.type"] !== expectedType)
		throw new Error(
			`The ref '${reference.ref}' names ${entity["@odata.type"]}, but this field needs ${expectedType}.`,
		)
	if (entity["@odata.type"] === "Microsoft.Dynamics.CRM.msdyn_projectbucket")
		return field === "msdyn_projectbucketid"
			? entity.msdyn_projectbucketid
			: `/msdyn_projectbuckets(${entity.msdyn_projectbucketid})`
	return field === "msdyn_projecttaskid"
		? entity.msdyn_projecttaskid
		: `/msdyn_projecttasks(${entity.msdyn_projecttaskid})`
}

// The schemas allow objects only for same-call refs. Every Microsoft
// field name and every supplied native value passes through unchanged.
function nativeEntity(
	operation: Operation,
	references: Map<string, CreatedReference>,
): Record<string, unknown> {
	const entity: Record<string, unknown> = {}
	const fields: [string, string | number | z.output<typeof pending> | undefined][] =
		Object.entries(operation)
	for (const [field, value] of fields) {
		if (field !== "ref")
			entity[field] =
				typeof value === "object" ? resolveReference(field, value, references) : value
	}
	return entity
}

const toolResult = (...records: Record<string, unknown>[]) => ({
	content: records.map((record) => ({
		text: JSON.stringify(record),
		type: "text" as const,
	})),
})

function errorText(error: unknown): string {
	if (error instanceof AggregateError)
		return `${error.message}: ${error.errors.map(errorText).join("; ")}`
	return error instanceof Error ? error.message : String(error)
}

export function createMcpServer(api: ScheduleApiClient): McpServer {
	const server = new McpServer({
		name: "microsoft-planner-premium",
		version: packageJson.version,
	})
	server.registerTool(
		"retrieve_records",
		{
			annotations: { readOnlyHint: true },
			description: [
				"Read Premium Planner records visible to the connected user using native Dataverse OData queries. Select a Planner entity set and optionally a record id. Pass query expressions as strings without URL-encoding them; Dataverse determines valid options for the request.",
				"Returns Microsoft's JSON unchanged, including custom columns, formatted-value annotations, expanded related data, counts and aggregate aliases. A collection returns value; an id returns a record. Related data may come from outside Planner. An empty collection does not establish that no records exist: Dataverse permissions apply.",
				"Returns one page. Pass a returned @odata.nextLink to retrieve_records_next_link to continue; no next link means the collection is complete. $top limits total results, not page size.",
				"To list projects, use entity_set msdyn_projects and $select msdyn_projectid,msdyn_subject. Use the chosen msdyn_projectid as ProjectId in submit_operation_set. Inspect operation-set receipts with wait_for_operation_set.",
			].join(" "),
			inputSchema: retrieveRecordsSchema,
		},
		async (input) => toolResult(await api.retrieveRecords(input)),
	)

	server.registerTool(
		"retrieve_records_next_link",
		{
			annotations: { readOnlyHint: true },
			description:
				"Continue a Planner Dataverse read using the exact @odata.nextLink returned by Microsoft, including a related collection's next link. The URL must remain in the connected environment and start from a Planner entity set. Returns one page of Microsoft's JSON unchanged with formatted-value annotations. Follow another returned next link to continue; no next link means the collection is complete.",
			inputSchema: z.strictObject({
				next_link: z
					.url()
					.describe(
						"The exact Microsoft @odata.nextLink URL; do not change or re-encode it",
					),
			}),
		},
		async ({ next_link }) => toolResult(await api.retrieveRecordsNextLink(next_link)),
	)

	server.registerTool(
		"submit_operation_set",
		{
			description: [
				"Change a Premium Planner (Project for the web) project. One call is one OPERATION SET — the scheduling service's transaction over many operations against ONE project, applied together or not at all.",
				"Put everything one intent needs into a single call and approval. Use Microsoft's native entity fields, @odata.type and OData binding strings. The top-level ProjectId and Description are Microsoft's action parameters; Description must summarize the changes in the human's words.",
				"Task and bucket creates may have a ref, which is local metadata removed before submission. A native binding property or update primary ID may instead contain { ref } to name a task or bucket created in this call. Omitted create IDs are generated and named refs are returned in created.",
				"Changing task dates can reschedule dependent tasks; the set reports only whether it completed.",
				"Returns Microsoft's OperationSetId — a RECEIPT, not confirmation that changes applied. Pass it to wait_for_operation_set. A failure after creation includes OperationSetId alongside the error; inspect that set before deciding what to do next.",
			].join(" "),
			inputSchema: submissionSchema,
		},
		async (submission) => {
			const references = collectReferences(submission.creates)
			const writes: StagedWrite[] = []
			for (const [verb, operations] of [
				["create", submission.creates],
				["update", submission.updates],
				["delete", submission.deletes],
			] as const) {
				for (const operation of operations)
					writes.push({ entity: nativeEntity(operation, references), verb })
			}
			try {
				const receipt = await submitOperationSet(api, {
					Description: submission.Description,
					ProjectId: submission.ProjectId,
					writes,
				})
				return toolResult({
					...receipt,
					created: Object.fromEntries(
						[...references].map(([ref, entity]) => [
							ref,
							entity["@odata.type"] === "Microsoft.Dynamics.CRM.msdyn_projecttask"
								? entity.msdyn_projecttaskid
								: entity.msdyn_projectbucketid,
						]),
					),
				})
			} catch (error) {
				if (!(error instanceof OperationSetSubmissionError)) throw error
				return {
					...toolResult({ ...error.receipt, error: errorText(error.cause) }),
					isError: true,
				}
			}
		},
	)

	server.registerTool(
		"wait_for_operation_set",
		{
			description:
				"Read a submitted operation set. Polls only while msdyn_status is executing, until the set settles or the window closes. Returns the native operation-set row: msdyn_operationsetid, numeric msdyn_status (192350000 open, 192350001 executing, 192350002 abandoned, 192350003 completed, 192350004 failed), and _msdyn_psserrorlog_value when present. A failed set adds a second content record with native msdyn_errorcode and msdyn_log. Completed means the service applied the set without error, not that every field holds the supplied value.",
			inputSchema: z.strictObject({
				// This receipt comes from Microsoft, not a GUID typed by the caller.
				OperationSetId: z
					.string()
					.min(1)
					.describe("The OperationSetId returned by submit_operation_set"),
				seconds: z
					.number()
					.int()
					.min(0)
					.max(MAX_WAIT_SECONDS)
					.describe(
						`How long to wait, 0-${MAX_WAIT_SECONDS}. 0 reads once. If still executing, call again.`,
					),
			}),
		},
		async (input) => toolResult(...(await waitForOperationSet(api, input))),
	)
	return server
}
