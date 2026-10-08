// The Premium Planner (Project-for-the-web) write-side MCP server running as a
// Cloudflare Worker. Standard MCP over HTTP: the CHATTING
// USER's delegated Dataverse token arrives per request in `Authorization`, and
// everything else derives from it — the org URL comes off the token's `aud` claim,
// so this server takes no configuration at all.
//
// THE EDGE, and only the edge. What lives here is what MCP makes us care about: the
// advertised schemas, the descriptions a model reads, the mapping from tool
// arguments to domain values, and the JSON that goes back. Sequencing the API is
// `operation-set.ts`; the wire is `schedule-api.ts`.
//
// THE SURFACE IS THE API'S OWN MODEL, not a CRUD shape laid over it. Submit and wait
// stay separate because execution is asynchronous; the OperationSet stays visible
// because it is the transaction and quota unit.
//
// A dumb wrapper on purpose: arguments carry GUIDs verbatim (the agent reads them
// from the synced msdyn_* tables) plus the human-readable labels the permission
// prompt shows. No name→id resolution, no lookup reads. The ONE exception is deliberate
// and local — a record created in this same submission has no GUID for the caller to
// know, so it is addressed by a submission-local `ref` that this file mints an id
// for. That is not a lookup: nothing is read, and the ids come back in the receipt.
//
// Edge validation prevents failures that the service reports only after consuming a
// set, and silent rewrites that it accepts as successful. The comments on each rule
// state which behavior it guards.

import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/server"
import { decodeJwt } from "jose"
import { z } from "zod"
import {
	MAX_WAIT_SECONDS,
	submitOperationSet,
	waitForOperationSet,
} from "@/lib/operation-set"
import {
	createProjectBucket,
	createProjectTask,
	createResourceAssignment,
	createScheduleApiClient,
	createTaskLabel,
	deleteRecord,
	type ScheduleApiClient,
	type StagedWrite,
	updateProjectBucket,
	updateProjectLabel,
	updateProjectTask,
} from "@/lib/schedule-api"
import packageJson from "@/package.json"

// Derived from the package's release-managed version, never a hand-kept literal.
const SERVER_VERSION = packageJson.version

/** The most operations one OperationSet will carry. The service's own ceiling. */
const MAX_OPERATIONS = 200

/**
 * A Dataverse row as the tools take it: the GUID does the work, the name is what the
 * human reads in the permission prompt. They are ONE object because they are one concept
 * — which makes "an id without its label" unrepresentable in the advertised schema,
 * rather than a runtime check that fires after a human has already approved.
 *
 * `guid()`, NOT `uuid()`: Dataverse GUIDs are not RFC-4122, so msdyn_* ids routinely
 * carry a non-version nibble (`…-f011-…`) that zod's `uuid()` rejects — a `uuid()`
 * here silently fails every real write at argument validation. `guid()` still
 * enforces the 8-4-4-4-12 shape. Do not tighten.
 */
const existing = (what: string, idColumn: string) =>
	z.strictObject({
		id: z.guid().describe(`${what} GUID from the synced Postgres tables (${idColumn})`),
		name: z.string().min(1).describe(`${what} name, for the human approving this action`),
	})

/**
 * A record being created in THIS submission, addressed by the caller's own label.
 *
 * It exists because record ids are client-supplied upstream, which is the whole
 * reason a task can be created into a bucket created alongside it. Rather than ask a
 * model to mint GUIDs and keep them unique, the caller names the new record and this
 * file mints the id — returning the mapping in the receipt.
 */
const pending = z.strictObject({
	ref: z
		.string()
		.min(1)
		.describe(
			"The `ref` of a record created in this same submission — how a task names a bucket that does not exist yet",
		),
})

const reference = (what: string, idColumn: string) =>
	z.union([existing(what, idColumn), pending])

type Reference = z.output<ReturnType<typeof reference>>

/** Require a full UTC timestamp because date-only input can land on a different working day. */
const instant = z.iso
	.datetime()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
		"must be a full UTC timestamp like 2026-08-28T17:00:00Z — a bare date is read as midnight and lands on the previous working day",
	)

const taskRef = () => reference("task", "msdyn_projecttaskid")
const bucketRef = () => reference("bucket", "msdyn_projectbucketid")

const taskCreate = z.strictObject({
	bucket: bucketRef().describe("The bucket the task goes in"),
	description: z
		.string()
		.optional()
		.describe("Body text for the task, shown under its name"),
	finish: instant.optional().describe("When the task is due"),
	kind: z.literal("task"),
	name: z.string().min(1).describe("The new task's name"),
	outline_level: z
		.number()
		.int()
		.min(1)
		.default(1)
		.describe(
			"1 for a top-level task. A subtask is its parent's level plus one — read the parent's msdyn_outlinelevel from the synced tables.",
		),
	parent_task: taskRef().optional().describe("Makes this a subtask of that task"),
	priority: z.number().int().min(0).max(10).optional().describe("0-10; 5 is the default"),
	ref: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Name this task so other operations here can reference it, and so the receipt returns its id",
		),
	start: instant.optional().describe("When work on the task starts"),
})

// `display_order` is deliberately unsupported; the recorder probe owns the service
// claim behind the omission.
const bucketCreate = z.strictObject({
	kind: z.literal("bucket"),
	name: z.string().min(1).describe("The new bucket's name"),
	ref: z
		.string()
		.min(1)
		.optional()
		.describe("Name this bucket so tasks in this same submission can go into it"),
})

const taskLabelCreate = z.strictObject({
	kind: z.literal("task_label"),
	// A label is never created — every project is born with twenty-five, unnamed — so
	// this one can only name an existing row, never a `ref`.
	label: existing("label", "msdyn_projectlabelid").describe(
		"The label to put on the task",
	),
	task: taskRef().describe("The task getting the label"),
})

const assignmentCreate = z.strictObject({
	kind: z.literal("assignment"),
	// The person is named by their project-team membership, not by a user or a
	// bookable resource: membership of THIS project is what an assignment attaches to.
	member: existing("project team member", "msdyn_projectteamid").describe(
		"The team member to assign, from msdyn_projectteams",
	),
	name: z
		.string()
		.min(1)
		.describe("A label for the assignment, shown to the human in the permission prompt"),
	task: taskRef().describe(
		"The task to assign. A task that has subtasks CANNOT be assigned to — the service refuses it.",
	),
})

const taskUpdate = z
	.strictObject({
		bucket: bucketRef()
			.optional()
			.describe("Move the task to this bucket, in the same project"),
		description: z.string().optional(),
		duration: z
			.number()
			.optional()
			.describe("Working days. Writing this moves the finish."),
		effort: z.number().optional().describe("Hours of work"),
		finish: instant.optional(),
		kind: z.literal("task"),
		name: z.string().min(1).optional().describe("Rename the task to this"),
		parent_task: taskRef().optional(),
		priority: z.number().int().min(0).max(10).optional(),
		progress: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe(
				"Fraction complete, 0-1 — 0.55 is 55%, and 1 is done. NOT a percentage: 55 is rejected.",
			),
		start: instant.optional(),
		task: taskRef().describe("The task to change"),
	})
	.refine(
		(input) =>
			input.bucket !== undefined ||
			input.description !== undefined ||
			input.duration !== undefined ||
			input.effort !== undefined ||
			input.finish !== undefined ||
			input.name !== undefined ||
			input.parent_task !== undefined ||
			input.priority !== undefined ||
			input.progress !== undefined ||
			input.start !== undefined,
		{
			message: "Nothing to update — a task update needs at least one changed field.",
		},
	)

// `display_order` is deliberately unsupported; the recorder's update display-order
// probe owns the service claim behind the omission.
const bucketUpdate = z.strictObject({
	bucket: bucketRef().describe("The bucket to change"),
	kind: z.literal("bucket"),
	name: z.string().min(1).describe("Rename the bucket to this"),
})

// `color_index` is deliberately unsupported; the recorder probe owns the service
// claim behind the omission.
const labelUpdate = z.strictObject({
	kind: z.literal("label"),
	label: existing("label", "msdyn_projectlabelid"),
	text: z
		.string()
		.describe(
			"The label's name. A project's labels start unnamed; clearing the text retires one.",
		),
})

// Only existing records are deletable. Buckets are deliberately absent because
// deleting one also deletes its tasks, which the permission prompt cannot disclose.

const taskDelete = z.strictObject({
	kind: z.literal("task"),
	task: existing("task", "msdyn_projecttaskid"),
})

const taskLabelDelete = z.strictObject({
	kind: z.literal("task_label"),
	link: existing("task-label link", "msdyn_projecttasktolabelid"),
})

const assignmentDelete = z.strictObject({
	assignment: existing("assignment", "msdyn_resourceassignmentid"),
	kind: z.literal("assignment"),
})

const createOperationSchema = z.discriminatedUnion("kind", [
	taskCreate,
	bucketCreate,
	taskLabelCreate,
	assignmentCreate,
])
const updateOperationSchema = z.discriminatedUnion("kind", [
	taskUpdate,
	bucketUpdate,
	labelUpdate,
])
const deleteOperationSchema = z.discriminatedUnion("kind", [
	taskDelete,
	taskLabelDelete,
	assignmentDelete,
])

/**
 * One submission, as the tool takes it.
 *
 * Defined at module scope so `Submission` derives from the exact schema and cannot
 * drift. The refinements enforce cross-field and service-boundary invariants that the
 * individual field schemas cannot express.
 */
const submissionSchema = z
	.strictObject({
		creates: z.array(createOperationSchema).default([]).describe("Records to create"),
		deletes: z
			.array(deleteOperationSchema)
			.default([])
			.describe(
				"Records to remove. Buckets cannot be deleted here — removing one takes every task in it.",
			),
		description: z
			.string()
			.min(1)
			.describe("What this set does, in the words of the person approving it"),
		project: existing("project", "msdyn_projectid"),
		updates: z.array(updateOperationSchema).default([]).describe("Records to change"),
	})
	// A set with nothing in it is refused at execute AND left OPEN — the one execute
	// failure that strands a slot against a ten-set-per-user quota with no API to find it
	// again. Checked before a set is ever minted.
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
	// Field schemas cannot enforce start <= finish. Compare parsed instants here because
	// the service otherwise accepts the write and can silently persist a different
	// schedule; fractional-second spellings are variable-width.
	.refine(
		(input) =>
			[...input.creates, ...input.updates].every((operation) => {
				const start = "start" in operation ? operation.start : undefined
				const finish = "finish" in operation ? operation.finish : undefined
				return (
					start === undefined ||
					finish === undefined ||
					Date.parse(start) <= Date.parse(finish)
				)
			}),
		{
			message:
				"finish is before start — the service accepts this, silently recomputes the finish from the duration, and still reports the set completed, so the board would end up holding dates you did not send",
		},
	)

/**
 * The caller's Dataverse credentials, recovered entirely from the request: the
 * delegated token in `Authorization`, and the org URL from its `aud` claim (`aud` IS
 * the `https://<org>.crm.dynamics.com` origin).
 */
function scheduleApiFromRequest(request: Request | undefined): ScheduleApiClient {
	const authorization = request?.headers.get("authorization")
	if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
		throw new Error(
			"No Dataverse access token reached the planner server — the chatting user has no linked Microsoft account with Dataverse scope. Link (or re-link) the Microsoft account, then retry.",
		)
	}
	const accessToken = authorization.slice("Bearer ".length)
	const aud = decodeJwt(accessToken).aud
	const audUrl = typeof aud === "string" ? URL.parse(aud) : null
	if (!audUrl || (audUrl.protocol !== "https:" && audUrl.protocol !== "http:")) {
		throw new Error(
			`The Dataverse access token's aud claim is not an org URL (got ${JSON.stringify(aud)}) — the token was minted for the wrong resource.`,
		)
	}
	return createScheduleApiClient({ accessToken, orgUrl: audUrl.origin })
}

const toolResult = (payload: Record<string, unknown>) => ({
	content: [{ text: JSON.stringify(payload), type: "text" as const }],
})

type Submission = z.output<typeof submissionSchema>

type PlannedCreate = { create: z.output<typeof createOperationSchema>; id: string }
type ReferencedCreate = { id: string; kind: "bucket" | "task" }

function assertNever(value: never, where: string): never {
	throw new Error(`Unhandled ${where}: ${JSON.stringify(value)}`)
}

/**
 * Every create paired with its id, and the subset the caller named.
 *
 * Mint each create id exactly once before mapping any writes. Client-supplied primary
 * keys let operations in the same set reference each other; only caller-named refs
 * enter `createsByRef`.
 */
function planCreates(requested: z.output<typeof createOperationSchema>[]): {
	createsByRef: Map<string, ReferencedCreate>
	plannedCreates: PlannedCreate[]
} {
	const createsByRef = new Map<string, ReferencedCreate>()
	const plannedCreates = requested.map((create) => {
		const id = randomUUID()
		if (
			(create.kind === "bucket" || create.kind === "task") &&
			create.ref !== undefined
		) {
			if (createsByRef.has(create.ref)) {
				throw new Error(
					`Two creates in this submission share the ref '${create.ref}' — a ref names exactly one record.`,
				)
			}
			createsByRef.set(create.ref, { id, kind: create.kind })
		}
		return { create, id }
	})
	return { createsByRef, plannedCreates }
}

function resolveReferenceId(
	createsByRef: Map<string, ReferencedCreate>,
	reference: Reference,
	expectedKind: ReferencedCreate["kind"],
): string {
	if ("id" in reference) return reference.id
	const created = createsByRef.get(reference.ref)
	if (created === undefined) {
		throw new Error(
			`Nothing in this submission is created with the ref '${reference.ref}'. A ref must name a create in the same call; an existing record is named by { id, name }.`,
		)
	}
	if (created.kind !== expectedKind) {
		throw new Error(
			`The ref '${reference.ref}' names a ${created.kind}, but this field needs a ${expectedKind}.`,
		)
	}
	return created.id
}

function writesOf(
	submission: Submission,
	plannedCreates: PlannedCreate[],
	createsByRef: Map<string, ReferencedCreate>,
): StagedWrite[] {
	const resolveId = (reference: Reference, kind: ReferencedCreate["kind"]) =>
		resolveReferenceId(createsByRef, reference, kind)
	const projectId = submission.project.id

	const staged: StagedWrite[] = []
	for (const { create, id: newId } of plannedCreates) {
		if (create.kind === "task") {
			staged.push(
				createProjectTask({
					bucketId: resolveId(create.bucket, "bucket"),
					description: create.description,
					finish: create.finish,
					outlineLevel: create.outline_level,
					parentTaskId:
						create.parent_task === undefined
							? undefined
							: resolveId(create.parent_task, "task"),
					priority: create.priority,
					projectId,
					start: create.start,
					subject: create.name,
					taskId: newId,
				}),
			)
		} else if (create.kind === "bucket") {
			staged.push(createProjectBucket({ bucketId: newId, name: create.name, projectId }))
		} else if (create.kind === "task_label") {
			staged.push(
				createTaskLabel({
					labelId: create.label.id,
					linkId: newId,
					taskId: resolveId(create.task, "task"),
				}),
			)
		} else if (create.kind === "assignment") {
			staged.push(
				createResourceAssignment({
					assignmentId: newId,
					name: create.name,
					projectId,
					projectTeamId: create.member.id,
					taskId: resolveId(create.task, "task"),
				}),
			)
		} else {
			assertNever(create, "create operation")
		}
	}

	for (const update of submission.updates) {
		if (update.kind === "task") {
			staged.push(
				updateProjectTask({
					bucketId:
						update.bucket === undefined ? undefined : resolveId(update.bucket, "bucket"),
					description: update.description,
					duration: update.duration,
					effort: update.effort,
					finish: update.finish,
					parentTaskId:
						update.parent_task === undefined
							? undefined
							: resolveId(update.parent_task, "task"),
					priority: update.priority,
					progress: update.progress,
					start: update.start,
					subject: update.name,
					taskId: resolveId(update.task, "task"),
				}),
			)
		} else if (update.kind === "bucket") {
			staged.push(
				updateProjectBucket({
					bucketId: resolveId(update.bucket, "bucket"),
					name: update.name,
				}),
			)
		} else if (update.kind === "label") {
			staged.push(updateProjectLabel({ labelId: update.label.id, text: update.text }))
		} else {
			assertNever(update, "update operation")
		}
	}

	for (const deleteOperation of submission.deletes) {
		if (deleteOperation.kind === "task")
			staged.push(deleteRecord({ id: deleteOperation.task.id, kind: "task" }))
		else if (deleteOperation.kind === "task_label")
			staged.push(deleteRecord({ id: deleteOperation.link.id, kind: "taskLabel" }))
		else if (deleteOperation.kind === "assignment")
			staged.push(deleteRecord({ id: deleteOperation.assignment.id, kind: "assignment" }))
		else assertNever(deleteOperation, "delete operation")
	}

	return staged
}

export function createMcpServer(): McpServer {
	const server = new McpServer({
		name: "microsoft-planner-premium",
		version: SERVER_VERSION,
	})

	server.registerTool(
		"submit_operation_set",
		{
			description: [
				"Change a Premium Planner (Project for the web) board. One call is one OPERATION SET — the scheduling service's own unit of work: a transaction over many operations, all against ONE project, applied together or not at all.",
				"Put everything one intent needs into a single call. Creating a bucket and the tasks that go in it, or renaming a task and setting its dates and assigning it, is one set and one approval — not several. A task can go into a bucket created in the SAME call by giving that bucket a `ref` and naming it.",
				"Read every id from the synced msdyn_* tables; each id travels with the matching name, which the human sees in the approval arguments. `description` is yours to write, so summarize the set in that human's words.",
				"Changing a task's dates can move OTHER tasks: tasks are auto-scheduled, so a task that has dependents drags them along, and the set reports only that it completed.",
				"Returns an operation_set_id — a RECEIPT, not a confirmation: the set has been accepted, not applied. Pass it to wait_for_operation_set to learn whether it landed.",
			].join(" "),
			inputSchema: submissionSchema,
		},
		async (submission, extra) => {
			const { createsByRef, plannedCreates } = planCreates(submission.creates)
			const operationSetId = await submitOperationSet(
				scheduleApiFromRequest(extra.http?.req),
				{
					description: submission.description,
					projectId: submission.project.id,
					writes: writesOf(submission, plannedCreates, createsByRef),
				},
			)
			return toolResult({
				created: Object.fromEntries(
					[...createsByRef].map(([ref, created]) => [ref, created.id]),
				),
				operation_set_id: operationSetId,
			})
		},
	)

	server.registerTool(
		"wait_for_operation_set",
		{
			description:
				"Find out what became of a submitted set. Takes the operation_set_id returned by submit_operation_set and reads it once. While the status is executing, it polls until the set becomes terminal or the window closes; any other status returns immediately. Reports the scheduling service's own status: completed, failed (with its reason), executing, open, or abandoned. Note that 'completed' means the service applied the set without error — it is not a promise that a field holds the value you sent.",
			inputSchema: z.strictObject({
				// A receipt this server minted and handed over, NOT an id read out of a
				// synced table — so unlike the references above, its lexical shape is
				// Dataverse's business and not ours to assert.
				operation_set_id: z
					.string()
					.min(1)
					.describe("The operation_set_id returned by submit_operation_set"),
				seconds: z
					.number()
					.int()
					.min(0)
					.max(MAX_WAIT_SECONDS)
					.describe(
						`How long to wait, 0-${MAX_WAIT_SECONDS}. 0 reads once and returns whatever the service says. If it still reports 'executing' when the window closes, call again.`,
					),
			}),
		},
		async ({ operation_set_id, seconds }, extra) => {
			const outcome = await waitForOperationSet(scheduleApiFromRequest(extra.http?.req), {
				operationSetId: operation_set_id,
				seconds,
			})
			return toolResult({ ...outcome })
		},
	)

	return server
}
