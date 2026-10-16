// Native Dataverse records and Project Schedule API actions. Microsoft owns the
// column names, choice values, OData entities, and action envelopes; this boundary
// validates supported reads and transports native writes without renaming them.
// Operation-set sequencing belongs to `operation-set.ts`.

import { z } from "zod"

/** The scheduling service's native `msdyn_status` choice values. */
export const OPERATION_SET_STATUS = {
	abandoned: 192350002,
	completed: 192350003,
	executing: 192350001,
	failed: 192350004,
	open: 192350000,
} as const

const operationSetRowSchema = z.discriminatedUnion("msdyn_status", [
	z.object({
		_msdyn_psserrorlog_value: z.string().nullish(),
		msdyn_operationsetid: z.string(),
		msdyn_status: z.literal([
			OPERATION_SET_STATUS.open,
			OPERATION_SET_STATUS.executing,
			OPERATION_SET_STATUS.abandoned,
			OPERATION_SET_STATUS.completed,
		]),
	}),
	// A failed set must retain the linked error log so waiting can read its account.
	z.object({
		_msdyn_psserrorlog_value: z.string(),
		msdyn_operationsetid: z.string(),
		msdyn_status: z.literal(OPERATION_SET_STATUS.failed),
	}),
])

const pssErrorLogRowSchema = z.object({
	msdyn_errorcode: z.string().nullish(),
	msdyn_log: z.string().nullish(),
})

const createOperationSetResponseSchema = z.object({
	OperationSetId: z.string().min(1),
})

const plannerEntitySetSchema = z.enum([
	"msdyn_projects",
	"msdyn_projecttasks",
	"msdyn_projecttaskdependencies",
	"msdyn_resourceassignments",
	"msdyn_projectbuckets",
	"msdyn_projectteams",
	"msdyn_projectchecklists",
	"msdyn_projectlabels",
	"msdyn_projecttasktolabels",
	"msdyn_projectsprints",
	"msdyn_projectgoals",
	"msdyn_projecttasktogoals",
])

export const retrieveRecordsSchema = z.strictObject({
	$apply: z
		.string()
		.optional()
		.describe("Native OData aggregation or grouping expression"),
	$count: z.string().optional().describe('Use "true" to request @odata.count'),
	$expand: z
		.string()
		.optional()
		.describe("Native related-record expansions, including nested query options"),
	$filter: z.string().optional().describe("Native OData filter expression"),
	$orderby: z
		.string()
		.optional()
		.describe("Native ordering; include a unique column when paging"),
	$select: z.string().optional().describe("Comma-separated native column names"),
	$top: z.string().optional().describe("Total result limit, not page size"),
	entity_set: plannerEntitySetSchema.describe("The Planner entity set to retrieve"),
	id: z.guid().optional().describe("Retrieve one record by its native Dataverse GUID"),
})

const recordsResponseSchema = z.record(z.string(), z.unknown())

export type OperationSet = z.output<typeof operationSetRowSchema>
export type PssErrorLog = z.output<typeof pssErrorLogRowSchema>
export type OperationSetReceipt = z.output<typeof createOperationSetResponseSchema>

/** Native entity, paired with the local verb selecting its V2 staging action. */
export type StagedWrite = {
	verb: "create" | "update" | "delete"
	entity: Record<string, unknown>
}

const SET_COLUMNS = "?$select=msdyn_status,_msdyn_psserrorlog_value"

export type ScheduleApiClient = {
	retrieveRecords: (
		input: z.output<typeof retrieveRecordsSchema>,
	) => Promise<Record<string, unknown>>
	retrieveRecordsNextLink: (nextLink: string) => Promise<Record<string, unknown>>
	createOperationSet: (input: {
		Description: string
		ProjectId: string
	}) => Promise<OperationSetReceipt>
	/** Stage every entity of one verb in a single V2 call. */
	stage: (input: {
		EntityCollection: Record<string, unknown>[]
		OperationSetId: string
		verb: StagedWrite["verb"]
	}) => Promise<void>
	executeOperationSet: (input: OperationSetReceipt) => Promise<void>
	abandonOperationSet: (input: OperationSetReceipt) => Promise<void>
	getOperationSet: (OperationSetId: string) => Promise<OperationSet>
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
		const response = await fetch(new URL(path, `${config.orgUrl}/api/data/v9.2/`), {
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

	async function readRecords(path: string): Promise<Record<string, unknown>> {
		return parseResponse(
			path,
			await hop(path, {
				headers: {
					Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
				},
				redirect: "error",
			}),
			recordsResponseSchema,
		)
	}

	return {
		abandonOperationSet: (input) => action("msdyn_AbandonOperationSetV1", input),
		createOperationSet: (input) =>
			action("msdyn_CreateOperationSetV1", input, createOperationSetResponseSchema),
		executeOperationSet: (input) => action("msdyn_ExecuteOperationSetV1", input),
		getOperationSet: (operationSetId) =>
			read(`msdyn_operationsets(${operationSetId})${SET_COLUMNS}`, operationSetRowSchema),
		getPssErrorLog: (errorLogId) =>
			read(
				`msdyn_psserrorlogs(${errorLogId})?$select=msdyn_log,msdyn_errorcode`,
				pssErrorLogRowSchema,
			),
		retrieveRecords: ({ entity_set, id, ...options }) => {
			const query = new URLSearchParams()
			for (const [name, value] of Object.entries(options)) {
				if (value !== undefined) query.set(name, value)
			}
			const path = id === undefined ? entity_set : `${entity_set}(${id})`
			return readRecords(`${path}?${query}`)
		},
		retrieveRecordsNextLink: (nextLink) => {
			const url = new URL(nextLink)
			const path = url.pathname.match(
				/^\/api\/data\/v9\.2\/([^/(]+)(?:\(([^)]+)\)(?:\/[A-Za-z_][A-Za-z0-9_]*)*)?$/,
			)
			if (
				url.origin !== new URL(config.orgUrl).origin ||
				url.username !== "" ||
				url.password !== "" ||
				url.hash !== "" ||
				path === null ||
				!plannerEntitySetSchema.safeParse(path[1]).success ||
				(path[2] !== undefined && !z.guid().safeParse(path[2]).success)
			) {
				throw new Error(
					"next_link must target a Planner entity set in the connected Dataverse environment",
				)
			}
			return readRecords(nextLink)
		},
		stage: (input) =>
			action(STAGE_ACTION[input.verb], {
				EntityCollection: input.EntityCollection,
				OperationSetId: input.OperationSetId,
			}),
	}
}
