// The Dataverse wire boundary for project reads and the Project Schedule APIs.
// The Schedule APIs are the ONLY write path Microsoft allows into
// Project-for-the-web's scheduling entities (direct Dataverse CRUD is rejected).
//
// EVERYTHING DATAVERSE-SHAPED STOPS HERE. Above this file the vocabulary is domain:
// a status is a name, a write is a verb carrying its entity, a failed set carries
// its error log. Below it the vocabulary is wire: msdyn_* columns, OData
// `@odata.bind` reference syntax, and `msdyn_status` choice codes. Nothing is
// translated twice, and nothing upstream ever has to know a number.
//
// THE OPERATION SET IS THE UNIT OF WORK, not the individual write. A set is a
// TRANSACTION scoped to one project: open it, stage operations into it, execute it,
// then read it until it settles. Execute returns 200 on ACCEPTANCE, not completion.
// This file exposes those as the separate calls they are; sequencing them is
// `operation-set.ts`'s job, not this one's.
//
// STAGING IS BATCHED BY VERB. The V2 staging actions each take a COLLECTION, so one
// set carries at most one create call, one update call and one delete call — each
// holding many entities. All three have been observed coexisting in a single set and
// applying together, and a create in the collection can reference another record
// created alongside it, because the ids are ours to mint and exist before the service
// does. That is what lets a new bucket and the tasks going into it be one transaction.
//
// Builders intentionally expose only columns evidenced against the Schedule API.
// Add a recorder probe before adding a column; Dataverse table metadata alone is not
// sufficient evidence that the scheduling actions accept it.

import { z } from "zod"

// ---------------------------------------------------------------- vocabulary

/** The lifecycle of an OperationSet, in the API's own five states. */
export type OperationSetStatus =
	| "open"
	| "executing"
	| "completed"
	| "failed"
	| "abandoned"

/**
 * A set as it reads back. `failed` carries its error log because a failed set
 * ALWAYS links one — that is a schema invariant here rather than a branch upstream,
 * so a set that ever arrives failed-but-unlinked fails loudly at this boundary with
 * the raw row attached, instead of being reported to a human as "no error log was
 * linked" when the truth is that the API changed under us.
 */
export type OperationSet =
	| { status: Exclude<OperationSetStatus, "failed"> }
	| { status: "failed"; errorLogId: string }

/**
 * The scheduling service's own account of why it failed a set. A column the wire
 * left null arrives as "" — upstream formats text, it does not branch on absence.
 */
export type PssErrorLog = { errorCode: string; log: string }

/**
 * One operation, as the Schedule API takes it: the verb and the entity it applies
 * to, minted together by the builders below. They are ONE value because they are one
 * decision — a `create` entity is not a thing that could also be deleted — and
 * pairing them at the call site is a mistake nobody should be able to make.
 */
export type StagedWrite = {
	verb: "create" | "update" | "delete"
	entity: Record<string, unknown>
}

/**
 * The record kinds this package can write, and the two wire facts each one needs:
 * its `@odata.type` and the column holding its primary key. One table rather than a
 * literal per builder, because a delete names a record by exactly these two things
 * and would otherwise have to restate every one of them.
 */
const RECORD = {
	assignment: {
		id: "msdyn_resourceassignmentid",
		type: "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
	},
	bucket: {
		id: "msdyn_projectbucketid",
		type: "Microsoft.Dynamics.CRM.msdyn_projectbucket",
	},
	label: {
		id: "msdyn_projectlabelid",
		type: "Microsoft.Dynamics.CRM.msdyn_projectlabel",
	},
	task: { id: "msdyn_projecttaskid", type: "Microsoft.Dynamics.CRM.msdyn_projecttask" },
	taskLabel: {
		id: "msdyn_projecttasktolabelid",
		type: "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
	},
} as const

export type RecordKind = keyof typeof RECORD

const identify = (kind: RecordKind, id: string) => ({
	"@odata.type": RECORD[kind].type,
	[RECORD[kind].id]: id,
})

/**
 * A lookup, in OData's reference syntax.
 *
 * The navigation property is NOT always the column that holds the lookup, and
 * Dataverse matches it case-sensitively: a task binds its project through
 * `msdyn_project` but a task-label link binds its task through `msdyn_ProjectTaskId`.
 * Every name passed here comes from the org's own `$metadata`, never from the
 * column name it resembles.
 */
export const bind = (
	navigationProperty: string,
	entitySet: string,
	id: string | undefined,
) =>
	id === undefined ? {} : { [`${navigationProperty}@odata.bind`]: `/${entitySet}(${id})` }

/**
 * The entity, minus the columns the caller did not name. THIS is what makes a partial
 * update partial.
 *
 * `undefined` and absent are the same thing to this API; a column is written or it is
 * not, and there is no third state to lose here.
 */
const written = (entity: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(entity).filter(([, value]) => value !== undefined))

// ------------------------------------------------------------------ the wire

// `msdyn_status` choice codes. Deliberately NOT exported: no production module may
// learn them from anywhere but this file. The recorder and the cassette gates
// (lib/cassette/) keep their own copies on purpose — a gate that checked the
// fixture against this table would only be checking the table against itself.
const OPERATION_SET_STATUS = {
	192350000: "open",
	192350001: "executing",
	192350002: "abandoned",
	192350003: "completed",
	192350004: "failed",
} as const

// A set row, named as it is parsed. An unrecognised choice code is refused rather
// than passed through — a sixth state would mean the lifecycle changed, which is
// not something to discover from a downstream `default:` branch.
//
// NOT strict, and it must never become strict: every read returns
// `msdyn_operationsetid` and `@odata.context` regardless of `$select`, so tightening
// this rejects every real response. (`$select` does genuinely project — an
// unrequested column is ABSENT, not null — and a misspelled one is a 400, so a null
// here can only mean "not populated".)
const operationSetRowSchema = z
	.object({
		_msdyn_psserrorlog_value: z.string().nullish(),
		msdyn_status: z
			.literal([192350000, 192350001, 192350002, 192350003, 192350004])
			.transform((code) => OPERATION_SET_STATUS[code]),
	})
	.transform((row, ctx): OperationSet => {
		if (row.msdyn_status !== "failed") return { status: row.msdyn_status }
		if (typeof row._msdyn_psserrorlog_value !== "string") {
			ctx.addIssue({
				code: "custom",
				message: "a failed operation set arrived with no linked error log",
			})
			return z.NEVER
		}
		return { errorLogId: row._msdyn_psserrorlog_value, status: "failed" }
	})

// Both columns are nullable on the wire; the client collapses a null to "".
const pssErrorLogRowSchema = z.object({
	msdyn_errorcode: z.string().nullish(),
	msdyn_log: z.string().nullish(),
})

const createOperationSetResponseSchema = z.object({
	OperationSetId: z.string().min(1),
})

const projectsResponseSchema = z.object({
	value: z.array(
		z
			.object({ msdyn_projectid: z.string(), msdyn_subject: z.string() })
			.transform((row) => ({ id: row.msdyn_projectid, name: row.msdyn_subject })),
	),
})

// The column list for operation-set reads. A compile-time constant because it is
// load-bearing: Dataverse refuses an unknown `$select` column with a 400, so a
// Microsoft rename breaks the poll loudly instead of quietly returning a row with
// the error-log reference missing.
const SET_COLUMNS = "?$select=msdyn_status,_msdyn_psserrorlog_value"

// ------------------------------------------------------------------- writes

/**
 * The task columns a create and an update spell identically.
 *
 * `msdyn_description` only — NEVER `msdyn_descriptionplaintext`. Writing the first
 * populates the second; writing the second directly is refused. A caller that set
 * both would be sending one column the service rejects, for nothing.
 *
 * Dates are forwarded unchanged. Callers must provide an unambiguous instant; this
 * layer does not normalize because doing so would guess their intent.
 */
function taskColumns(fields: {
	description?: string
	finish?: string
	priority?: number
	start?: string
}): Record<string, unknown> {
	return {
		msdyn_description: fields.description,
		msdyn_finish: fields.finish,
		msdyn_priority: fields.priority,
		msdyn_start: fields.start,
	}
}

/**
 * A NEW project task.
 *
 * The primary key is OURS to choose: the service honours a client-supplied
 * `msdyn_projecttaskid`. That is what lets a caller know the id before the write has
 * been executed — and what lets this task name a BUCKET created in the same batch.
 *
 * `outlineLevel` is the caller's to state rather than ours to default. A subtask sits
 * one level below its parent, and this file cannot learn a parent's level without a
 * read it has no business making; the caller supplies the parent's outline level.
 */
export function createProjectTask(fields: {
	bucketId: string
	description?: string
	finish?: string
	outlineLevel: number
	parentTaskId?: string
	priority?: number
	projectId: string
	start?: string
	subject: string
	taskId: string
}): StagedWrite {
	return {
		entity: written({
			...identify("task", fields.taskId),
			msdyn_outlinelevel: fields.outlineLevel,
			msdyn_subject: fields.subject,
			...bind("msdyn_project", "msdyn_projects", fields.projectId),
			...bind("msdyn_projectbucket", "msdyn_projectbuckets", fields.bucketId),
			...bind("msdyn_parenttask", "msdyn_projecttasks", fields.parentTaskId),
			...taskColumns(fields),
		}),
		verb: "create",
	}
}

/**
 * A CHANGE to an existing task: only the named columns are written, which is what
 * makes a partial update partial. The project is deliberately not expressible — a
 * change cannot move a task to another project.
 *
 * Cross-project moves are deliberately unsupported because they can silently mutate
 * unintended data rather than fail.
 *
 * Date updates can reschedule dependent tasks. This builder forwards them without
 * attempting impact analysis.
 */
export function updateProjectTask(fields: {
	bucketId?: string
	description?: string
	duration?: number
	effort?: number
	finish?: string
	parentTaskId?: string
	priority?: number
	// Fraction complete, 0-1. Project for the Web has no separate "done" flag:
	// `msdyn_progress: 1` IS complete, and `statecode` does not move.
	progress?: number
	start?: string
	subject?: string
	taskId: string
}): StagedWrite {
	return {
		entity: written({
			...identify("task", fields.taskId),
			// Working days, and the schedule's own arithmetic: writing a duration moves
			// the finish, and writing start and finish computes a duration.
			msdyn_duration: fields.duration,
			msdyn_effort: fields.effort,
			msdyn_progress: fields.progress,
			msdyn_subject: fields.subject,
			...bind("msdyn_projectbucket", "msdyn_projectbuckets", fields.bucketId),
			...bind("msdyn_parenttask", "msdyn_projecttasks", fields.parentTaskId),
			...taskColumns(fields),
		}),
		verb: "update",
	}
}

/**
 * A NEW bucket on a project.
 *
 * Display order is deliberately unsupported; the recorder's create display-order
 * probe owns the service claim behind that omission.
 */
export function createProjectBucket(fields: {
	bucketId: string
	name: string
	projectId: string
}): StagedWrite {
	return {
		entity: {
			...identify("bucket", fields.bucketId),
			msdyn_name: fields.name,
			...bind("msdyn_project", "msdyn_projects", fields.projectId),
		},
		verb: "create",
	}
}

/**
 * Rename an existing bucket.
 *
 * Reordering is deliberately unsupported; the recorder's update display-order probe
 * owns the service claim behind that omission.
 */
export function updateProjectBucket(fields: {
	bucketId: string
	name: string
}): StagedWrite {
	return {
		entity: { ...identify("bucket", fields.bucketId), msdyn_name: fields.name },
		verb: "update",
	}
}

/**
 * Rename a label. Its colour is not ours to change.
 *
 * A label is never CREATED, and the API offers no way to: every project is born with
 * twenty-five of them, unnamed, one per colour. So the only way to have a label
 * called "Blocked" is to rename one that already exists, and the only way to be rid
 * of one is to clear its text.
 *
 * Colour is deliberately unsupported; the recorder's label-colour probe owns the
 * service claim behind that omission.
 */
export function updateProjectLabel(fields: {
	labelId: string
	text: string
}): StagedWrite {
	return {
		entity: {
			...identify("label", fields.labelId),
			msdyn_projectlabeltext: fields.text,
		},
		verb: "update",
	}
}

/**
 * Put a label on a task. A join row — so taking the label off is deleting this row,
 * which is why there is no `updateTaskLabel` to go with it.
 */
export function createTaskLabel(fields: {
	labelId: string
	linkId: string
	taskId: string
}): StagedWrite {
	return {
		entity: {
			...identify("taskLabel", fields.linkId),
			...bind("msdyn_ProjectTaskId", "msdyn_projecttasks", fields.taskId),
			...bind("msdyn_ProjectLabelId", "msdyn_projectlabels", fields.labelId),
		},
		verb: "create",
	}
}

/**
 * Assign a project team member to a task.
 *
 * An assignment inherits its task's dates and identifies the assignee by project-team
 * membership.
 */
export function createResourceAssignment(fields: {
	assignmentId: string
	name: string
	projectId: string
	projectTeamId: string
	taskId: string
}): StagedWrite {
	return {
		entity: {
			...identify("assignment", fields.assignmentId),
			msdyn_name: fields.name,
			...bind("msdyn_taskid", "msdyn_projecttasks", fields.taskId),
			...bind("msdyn_projectid", "msdyn_projects", fields.projectId),
			...bind("msdyn_projectteamid", "msdyn_projectteams", fields.projectTeamId),
		},
		verb: "create",
	}
}

/**
 * Remove a record. A staged delete names its record exactly as a create does — type
 * and id — so one shape covers every kind this package can write.
 */
export function deleteRecord(fields: { id: string; kind: RecordKind }): StagedWrite {
	return { entity: identify(fields.kind, fields.id), verb: "delete" }
}

// ------------------------------------------------------------------- client

export type ScheduleApiClient = {
	listProjects: () => Promise<z.output<typeof projectsResponseSchema>["value"]>
	createOperationSet: (input: {
		description: string
		projectId: string
	}) => Promise<string>
	/**
	 * Stage every entity of ONE verb into a set, in a single call.
	 *
	 * An EMPTY collection is the caller's to avoid rather than ours to tolerate: the
	 * action rejects one, and a set that reaches execute holding nothing is rejected
	 * too — and, uniquely among execute failures, stays OPEN against the per-user
	 * quota with no API that can find it again.
	 */
	stage: (input: {
		entities: Record<string, unknown>[]
		operationSetId: string
		verb: StagedWrite["verb"]
	}) => Promise<void>
	executeOperationSet: (operationSetId: string) => Promise<void>
	abandonOperationSet: (operationSetId: string) => Promise<void>
	getOperationSet: (operationSetId: string) => Promise<OperationSet>
	getPssErrorLog: (errorLogId: string) => Promise<PssErrorLog>
}

/** A non-2xx answer from the Schedule API, distinct from local/schema failures. */
export class ScheduleApiError extends Error {
	override readonly name = "ScheduleApiError"

	constructor(
		readonly path: string,
		readonly status: number,
		readonly statusText: string,
		readonly responseBody: string,
	) {
		super(
			`Schedule API ${path} failed: ${status} ${statusText}${
				responseBody ? ` — ${responseBody}` : ""
			}`,
		)
	}
}

const STAGE_ACTION: Record<StagedWrite["verb"], string> = {
	create: "msdyn_PssCreateV2",
	delete: "msdyn_PssDeleteV2",
	update: "msdyn_PssUpdateV2",
}

export function createScheduleApiClient(config: {
	/** The Dataverse org origin (`https://<org>.crm.dynamics.com`), no trailing slash. */
	orgUrl: string
	/**
	 * The caller's DELEGATED access token. The Schedule APIs reject application
	 * identities outright, so this is always a specific human's token, and every
	 * write lands as that human.
	 */
	accessToken: string
}): ScheduleApiClient {
	// The one hop against the org: the auth header and the loud non-2xx throw.
	// Private — callers reach it through `action` or `read`, which is what keeps
	// "an action with no body" and "a read with one" from being expressible.
	async function hop(
		path: string,
		init: RequestInit & { headers?: Record<string, string> },
	): Promise<string> {
		const response = await fetch(`${config.orgUrl}/api/data/v9.2/${path}`, {
			...init,
			headers: {
				accept: "application/json",
				authorization: `Bearer ${config.accessToken}`,
				...init.headers,
			},
		})
		if (!response.ok) {
			// The body is where the answer is, and it is the caller's only channel: a
			// column the service will not take, a value out of range, a missing required
			// column and a record that resolves to nothing are told apart by this text
			// and its `ScheduleAPI-__-000_` code, and by nothing else. The status alone
			// is diagnostic too, so a body that will not read must not replace it with
			// something less useful.
			const detail = await response.text().catch(() => "")
			throw new ScheduleApiError(path, response.status, response.statusText, detail)
		}
		return await response.text()
	}

	// A response that is a contract: a body that does not match its schema names the
	// call and quotes what arrived, because a thrown `.message` is all the caller ever
	// sees.
	//
	// There is deliberately NO handling for an empty or non-JSON body. Every recorded
	// response — success, 4xx and 404 alike — carries JSON; the only empty body
	// belongs to a 401, which `hop` rejects before reaching here.
	function parseResponse<Schema extends z.ZodType>(
		path: string,
		raw: string,
		schema: Schema,
	): z.output<Schema> {
		const parsed = schema.safeParse(JSON.parse(raw))
		if (!parsed.success) {
			throw new Error(
				`Schedule API ${path} returned an unexpected shape: ${raw} — ${parsed.error.message}`,
			)
		}
		return parsed.data
	}

	/**
	 * A Schedule API action: POST a named body.
	 *
	 * NO SCHEMA is the deliberate spelling for an action whose 2xx IS the whole result
	 * — stage, execute, abandon. Their bodies are read off the socket and dropped
	 * rather than parsed: nothing reads them, so parsing could only turn "the service
	 * said something odd about a write that succeeded" into a failed call. `hop` still
	 * throws on any non-2xx, so a rejected action fails exactly as loudly.
	 */
	async function action(name: string, body: Record<string, unknown>): Promise<void>
	async function action<Schema extends z.ZodType>(
		name: string,
		body: Record<string, unknown>,
		schema: Schema,
	): Promise<z.output<Schema>>
	async function action<Schema extends z.ZodType>(
		name: string,
		body: Record<string, unknown>,
		schema?: Schema,
	): Promise<z.output<Schema> | undefined> {
		const raw = await hop(name, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		return schema === undefined ? undefined : parseResponse(name, raw, schema)
	}

	/** A Dataverse read: bare GET, and the response is always a contract. */
	async function read<Schema extends z.ZodType>(
		path: string,
		schema: Schema,
	): Promise<z.output<Schema>> {
		return parseResponse(path, await hop(path, {}), schema)
	}

	return {
		abandonOperationSet: (operationSetId) =>
			action("msdyn_AbandonOperationSetV1", { OperationSetId: operationSetId }),
		createOperationSet: async (input) => {
			const response = await action(
				"msdyn_CreateOperationSetV1",
				{ Description: input.description, ProjectId: input.projectId },
				createOperationSetResponseSchema,
			)
			return response.OperationSetId
		},
		executeOperationSet: (operationSetId) =>
			action("msdyn_ExecuteOperationSetV1", { OperationSetId: operationSetId }),
		getOperationSet: (operationSetId) =>
			read(`msdyn_operationsets(${operationSetId})${SET_COLUMNS}`, operationSetRowSchema),
		getPssErrorLog: async (errorLogId) => {
			const row = await read(
				`msdyn_psserrorlogs(${errorLogId})?$select=msdyn_log,msdyn_errorcode`,
				pssErrorLogRowSchema,
			)
			return { errorCode: row.msdyn_errorcode ?? "", log: row.msdyn_log ?? "" }
		},
		listProjects: async () => {
			const response = await read(
				"msdyn_projects?$select=msdyn_projectid,msdyn_subject",
				projectsResponseSchema,
			)
			return response.value
		},
		stage: (input) =>
			action(STAGE_ACTION[input.verb], {
				EntityCollection: input.entities,
				OperationSetId: input.operationSetId,
			}),
	}
}
