// The planner server proven over its production Worker HTTP entrypoint
// — a fresh server per request in createMcpHandler, the MCP SDK's own
// client as the caller — against an org that only ever says what the REAL one was
// recorded saying (lib/cassette/, ../__goldens__/schedule-api.json).
//
// Nothing here invents a Dataverse response, and nothing here invents a SEQUENCE
// either: a test declares which recorded chain it is replaying, and the statuses
// come back in the order the org produced them. That second part is not a detail —
// a harness that lets the test assemble the progression can assert accept-then-fail
// on evidence that does not exist.
//
// The caller's token carries the replay org's origin in `aud`, so the server routes
// itself — no configuration anywhere, which is also the production contract.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { UnsecuredJWT } from "jose"
import { afterEach, describe, expect, it } from "vitest"
import app from "@/index"
import { type RecordedOrg, serveRecordedOrg } from "@/lib/cassette/replay"
import { MAX_WAIT_SECONDS, readInstants } from "@/lib/operation-set"

// Dataverse-SHAPED GUIDs: the `f011` third group is not an RFC-4122 version nibble,
// which is exactly how real msdyn_* ids look. Keep them non-RFC-4122: an RFC-4122
// exemplar here sails through a `z.uuid()` schema that many production GUIDs fail
// — a green suite over a broken write — and these fixtures are what pin `guid()`
// over `uuid()`.
const PROJECT = { id: "9c8b7a65-4321-f011-8dcb-0a1b2c3d4e5f", name: "Gable" }
const BUCKET = { id: "1f2e3d4c-5b6a-f011-9e8d-7c6b5a4f3e2d", name: "GBLPBI02" }
const TASK = {
	id: "5a4b3c2d-1e0f-f011-b7a6-9d8c7b6a5f4e",
	name: "Follow up on Gable PBI",
}
const LABEL = { id: "3c2d1e0f-4b5a-f011-8c7b-6a5f4e3d2c1b", name: "Blocked" }
const PROJECT_TEAM_MEMBER = {
	id: "7f6e5d4c-3b2a-f011-9a8b-1c2d3e4f5a6b",
	name: "Komal Farooq",
}
const TASK_LABEL_LINK = {
	id: "2d1e0f3c-5a4b-f011-7b6a-4e3d2c1b0f9e",
	name: "Blocked on Follow up",
}
const ASSIGNMENT = {
	id: "8a9b0c1d-2e3f-f011-4a5b-6c7d8e9f0a1b",
	name: "Komal on Follow up",
}

const ONE_TASK_SUBMISSION = {
	creates: [{ bucket: BUCKET, kind: "task", name: TASK.name }],
	description: "Add the Gable follow-up",
	project: PROJECT,
}

const NAMES_NOTHING = "{{unknownTaskId}}"

let org: RecordedOrg
let accessToken: string

/**
 * Stand up the recorded org and drive the planner Worker's HTTP entrypoint.
 * `replaying` names the recorded chain this test drives; omitted only by tests that
 * touch no Dataverse traffic. `auth: null` connects with NO Authorization header —
 * the no-linked-account path.
 */
async function connect(
	options: { auth?: null; replaying?: string } = {},
): Promise<Client> {
	org = await serveRecordedOrg({ replaying: options.replaying })
	// An unsigned-but-decodable JWT whose aud is the replay org — exactly the property
	// the server derives its org URL from.
	accessToken = new UnsecuredJWT({}).setAudience(org.url).encode()

	const client = new Client({ name: "test-caller", version: "1.0.0" })
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://planner.example/mcp"), {
			fetch: async (input, init) => app.fetch(new Request(input, init)),
			requestInit:
				options.auth === null
					? undefined
					: { headers: { Authorization: `Bearer ${accessToken}` } },
		}),
	)
	return client
}

const actionNames = () => org.calls.map((call) => call.action)
const mintedSetId = (): string => {
	const id = org.mintedOperationSetIds[0]
	if (id === undefined) throw new Error("the replayed chain minted no operation set")
	return id
}
const resultText = (result: Awaited<ReturnType<Client["callTool"]>>) =>
	JSON.stringify(result.content)
const payloadOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
	JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "") as Record<
		string,
		// `created` is an object of ref → id; everything else this server returns is a
		// string. Typed loosely here rather than narrowed at every call site.
		string | Record<string, string>
	>
const stagedEntitiesForAction = (action: string): Record<string, unknown>[] =>
	(org.calls.find((call) => call.action === action)?.body.EntityCollection ??
		[]) as Record<string, unknown>[]

/**
 * Every object in an advertised input schema, path → its `additionalProperties`.
 *
 * Walked rather than enumerated so an object added later without strictness fails
 * this too, instead of quietly widening the surface a caller may send. Descends
 * through array items and union branches as well as properties, because the argument
 * shapes here are arrays of unions and an unwalked branch is exactly where a
 * non-strict object would hide.
 */
function advertisedStrictness(schema: unknown, path = "(root)"): Record<string, unknown> {
	if (typeof schema !== "object" || schema === null) return {}
	const node = schema as {
		additionalProperties?: unknown
		anyOf?: unknown[]
		items?: unknown
		oneOf?: unknown[]
		properties?: Record<string, unknown>
		type?: unknown
	}
	const here = node.type === "object" ? { [path]: node.additionalProperties } : {}
	const children = [
		...Object.entries(node.properties ?? {}).map(([key, child]) =>
			advertisedStrictness(child, path === "(root)" ? key : `${path}.${key}`),
		),
		...(node.items === undefined ? [] : [advertisedStrictness(node.items, `${path}[]`)]),
		...[...(node.anyOf ?? []), ...(node.oneOf ?? [])].map((branch, at) =>
			advertisedStrictness(branch, `${path}|${at}`),
		),
	]
	return Object.assign(here, ...children)
}

afterEach(async () => {
	await org?.close()
})

describe("the advertised surface", () => {
	it("exposes project discovery alongside submit and wait", async () => {
		const client = await connect()
		const tools = await client.listTools()
		await client.close()
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"list_projects",
			"submit_operation_set",
			"wait_for_operation_set",
		])
	})

	it("advertises list_projects as a read-only tool with no arguments", async () => {
		// No project-list response has been recorded yet. Discovery is the server's
		// contract; a Dataverse round trip must wait for the real recording.
		const client = await connect()
		const { tools } = await client.listTools()
		await client.close()

		const list = tools.find((tool) => tool.name === "list_projects")
		expect(list?.annotations?.readOnlyHint).toBe(true)
		expect(list?.inputSchema).toMatchObject({
			additionalProperties: false,
			type: "object",
		})
		expect(list?.inputSchema.properties).toEqual({})
		expect(org.calls).toEqual([])
		expect(org.reads).toEqual([])
	})

	it("advertises the wait-window bounds", async () => {
		// Whatever the ADVERTISED JSON Schema carries is checked in the calling model's
		// MCP client, before a call is dispatched and therefore before a permission prompt
		// is raised. A regression here is silent — the server still validates — so it is
		// asserted rather than assumed.
		const client = await connect()
		const { tools } = await client.listTools()
		await client.close()

		const wait = tools.find((tool) => tool.name === "wait_for_operation_set")?.inputSchema
		expect(wait?.properties?.seconds).toMatchObject({ maximum: 45, minimum: 0 })
		expect(advertisedStrictness(wait)).toEqual({ "(root)": false })
	})

	it("advertises no way to delete a bucket", async () => {
		const client = await connect()
		const { tools } = await client.listTools()
		await client.close()
		const submit = tools.find((tool) => tool.name === "submit_operation_set")?.inputSchema
		const kinds = JSON.stringify(
			(submit?.properties?.deletes as { items?: unknown } | undefined)?.items ?? {},
		)
		expect(kinds).toContain("task")
		expect(kinds).toContain("assignment")
		expect(kinds).not.toContain("bucket")
	})

	it("makes every advertised object strict, at every level", async () => {
		// A misspelled key must be REFUSED rather than dropped: a dropped key is a
		// partial write reported as a success, which is how a typo becomes a task with
		// no due date that nobody notices.
		const client = await connect()
		const { tools } = await client.listTools()
		await client.close()
		const submit = tools.find((tool) => tool.name === "submit_operation_set")?.inputSchema
		const strictness = advertisedStrictness(submit)
		expect(Object.keys(strictness).length).toBeGreaterThan(10)
		expect(Object.values(strictness).every((value) => value === false)).toBe(true)
	})
})

describe("submit_operation_set", () => {
	it("stages one create, executes it, and returns WITHOUT waiting", async () => {
		const client = await connect({ replaying: "create-task" })
		const result = await client.callTool({
			arguments: ONE_TASK_SUBMISSION,
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		expect(actionNames()).toEqual([
			"msdyn_CreateOperationSetV1",
			"msdyn_PssCreateV2",
			"msdyn_ExecuteOperationSetV1",
		])
		expect(org.reads).toEqual([])

		// The receipt is the set the tool actually executed, not merely a string.
		expect(payloadOf(result).operation_set_id).toBe(org.calls[2]?.body.OperationSetId)
		// The description the caller wrote is what the set carries, because it is also
		// what the human approving the call reads.
		expect(org.calls[0]?.body).toEqual({
			Description: "Add the Gable follow-up",
			ProjectId: PROJECT.id,
		})
		expect(stagedEntitiesForAction("msdyn_PssCreateV2")[0]).toMatchObject({
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_outlinelevel: 1,
			"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.id})`,
			"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.id})`,
			msdyn_subject: TASK.name,
		})
		// Every hop carries the caller's delegated token — the Schedule APIs reject
		// application identities, so a write that lost it would not be a write at all.
		for (const call of org.calls) expect(call.authorization).toBe(`Bearer ${accessToken}`)
	})

	it("writes a task's dates, description and priority in the one staged entity", async () => {
		const client = await connect({ replaying: "create-task-with-every-field" })
		await client.callTool({
			arguments: {
				creates: [
					{
						bucket: BUCKET,
						description: "What the client asked for, and by when.",
						finish: "2026-09-11T17:00:00Z",
						kind: "task",
						name: TASK.name,
						priority: 7,
						start: "2026-09-07T09:00:00Z",
					},
				],
				description: "Add the Gable follow-up with its dates",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(stagedEntitiesForAction("msdyn_PssCreateV2")[0]).toMatchObject({
			msdyn_description: "What the client asked for, and by when.",
			msdyn_finish: "2026-09-11T17:00:00Z",
			msdyn_priority: 7,
			msdyn_start: "2026-09-07T09:00:00Z",
		})
		expect(stagedEntitiesForAction("msdyn_PssCreateV2")[0]).not.toHaveProperty(
			"msdyn_descriptionplaintext",
		)
	})

	it("creates a bucket and puts tasks into it in ONE set, by ref", async () => {
		const client = await connect({ replaying: "create-bucket-with-its-tasks" })
		const result = await client.callTool({
			arguments: {
				creates: [
					{ kind: "bucket", name: "Northbay", ref: "b1" },
					{ bucket: { ref: "b1" }, kind: "task", name: "Northbay - DLP policy doc" },
					{ bucket: { ref: "b1" }, kind: "task", name: "Northbay - training deck" },
				],
				description: "Add the Northbay bucket and Tuesday's two follow-ups",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		expect(actionNames()).toEqual([
			"msdyn_CreateOperationSetV1",
			"msdyn_PssCreateV2",
			"msdyn_ExecuteOperationSetV1",
		])
		const staged = stagedEntitiesForAction("msdyn_PssCreateV2")
		expect(staged).toHaveLength(3)

		const created = payloadOf(result).created as Record<string, string>
		expect(Object.keys(created)).toEqual(["b1"])
		expect(staged[0]).toMatchObject({ msdyn_name: "Northbay" })
		expect(staged[0]?.msdyn_projectbucketid).toBe(created.b1)
		for (const task of staged.slice(1)) {
			expect(task["msdyn_projectbucket@odata.bind"]).toBe(
				`/msdyn_projectbuckets(${created.b1})`,
			)
		}
	})

	it("carries creates, updates and deletes in one set, one call per verb", async () => {
		const client = await connect({ replaying: "create-update-and-delete-together" })
		const result = await client.callTool({
			arguments: {
				creates: [{ bucket: BUCKET, kind: "task", name: "New from the call" }],
				deletes: [{ kind: "task", task: TASK }],
				description: "Add one, rename one, drop one",
				project: PROJECT,
				updates: [{ kind: "task", name: "Renamed", task: TASK }],
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		expect(actionNames()).toEqual([
			"msdyn_CreateOperationSetV1",
			"msdyn_PssCreateV2",
			"msdyn_PssUpdateV2",
			"msdyn_PssDeleteV2",
			"msdyn_ExecuteOperationSetV1",
		])
		const sets = new Set(
			org.calls.slice(1).map((call) => call.body.OperationSetId as string),
		)
		expect(sets.size).toBe(1)
	})

	it("stages many tasks as one collection, not one set each", async () => {
		const client = await connect({ replaying: "create-many-tasks" })
		await client.callTool({
			arguments: {
				creates: [1, 2, 3].map((n) => ({
					bucket: BUCKET,
					kind: "task",
					name: `Batch ${n}`,
				})),
				description: "Three at once",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(actionNames().filter((a) => a === "msdyn_CreateOperationSetV1")).toHaveLength(
			1,
		)
		expect(stagedEntitiesForAction("msdyn_PssCreateV2")).toHaveLength(3)
	})

	it("puts a label on a task, and takes it off by deleting the join row", async () => {
		const attach = await connect({ replaying: "attach-label" })
		await attach.callTool({
			arguments: {
				creates: [{ kind: "task_label", label: LABEL, task: TASK }],
				description: "Mark it blocked",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		// The navigation properties are CAPITALISED and Dataverse matches them
		// case-sensitively — lowercase here fails every attach, which is why the exact
		// keys are pinned rather than the values alone.
		expect(stagedEntitiesForAction("msdyn_PssCreateV2")[0]).toMatchObject({
			"msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${LABEL.id})`,
			"msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${TASK.id})`,
		})
		await attach.close()
		await org.close()

		const detach = await connect({ replaying: "detach-label" })
		await detach.callTool({
			arguments: {
				deletes: [{ kind: "task_label", link: TASK_LABEL_LINK }],
				description: "Unblock it",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await detach.close()
		expect(actionNames()).toContain("msdyn_PssDeleteV2")
	})

	it("assigns a team member to a task, with no dates on the assignment", async () => {
		const client = await connect({ replaying: "assign-task" })
		await client.callTool({
			arguments: {
				creates: [
					{
						kind: "assignment",
						member: PROJECT_TEAM_MEMBER,
						name: PROJECT_TEAM_MEMBER.name,
						task: TASK,
					},
				],
				description: "Give it to Komal",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		const staged = stagedEntitiesForAction("msdyn_PssCreateV2")[0]
		expect(staged).toMatchObject({
			msdyn_name: PROJECT_TEAM_MEMBER.name,
			"msdyn_projectid@odata.bind": `/msdyn_projects(${PROJECT.id})`,
			"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${PROJECT_TEAM_MEMBER.id})`,
			"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${TASK.id})`,
		})
		expect(staged).not.toHaveProperty("msdyn_start")
		expect(staged).not.toHaveProperty("msdyn_finish")
	})

	it("takes a task off a team member by deleting the assignment row", async () => {
		// Un-assigning has no verb of its own: an assignment IS a row, so removing the
		// person is removing it. That is why there is no `updateResourceAssignment`
		// alongside the create.
		const client = await connect({ replaying: "unassign-task" })
		await client.callTool({
			arguments: {
				deletes: [{ assignment: ASSIGNMENT, kind: "assignment" }],
				description: "Take it off Komal",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(actionNames()).toEqual([
			"msdyn_CreateOperationSetV1",
			"msdyn_PssDeleteV2",
			"msdyn_ExecuteOperationSetV1",
		])
		expect(stagedEntitiesForAction("msdyn_PssDeleteV2")[0]).toEqual({
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
			msdyn_resourceassignmentid: ASSIGNMENT.id,
		})
	})
})

describe("arguments the tool refuses before any Dataverse traffic", () => {
	it("refuses a submission with nothing in it", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [],
				deletes: [],
				description: "nothing",
				project: PROJECT,
				updates: [],
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("at least one create, update or delete")
		expect(org.calls).toEqual([])
	})

	it("refuses a date with no time of day", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [{ bucket: BUCKET, finish: "2026-08-28", kind: "task", name: "x" }],
				description: "due Friday",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("previous working day")
		expect(org.calls).toEqual([])
	})

	it("refuses a timestamp that names no real instant", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						bucket: BUCKET,
						finish: "2026-02-30T17:00:00Z",
						kind: "task",
						name: "x",
					},
				],
				description: "an impossible date",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(org.calls).toEqual([])
	})

	it("compares differently spelled fractional seconds as instants", async () => {
		const client = await connect({ replaying: "create-task-with-every-field" })
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						bucket: BUCKET,
						finish: "2026-09-11T17:00:00.10Z",
						kind: "task",
						name: "x",
						start: "2026-09-11T17:00:00.1Z",
					},
				],
				description: "equal instants",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError ?? false).toBe(false)
	})

	it("refuses an inverted range whose fractional spelling sorts the other way", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						bucket: BUCKET,
						finish: "2026-09-11T17:00:00.1Z",
						kind: "task",
						name: "x",
						start: "2026-09-11T17:00:00.11Z",
					},
				],
				description: "an inverted subsecond range",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("finish is before start")
		expect(org.calls).toEqual([])
	})

	it("refuses a ref that names nothing in the same submission", async () => {
		// This one CANNOT live in the advertised schema: whether a ref is valid depends
		// on a sibling field of the same object, which JSON Schema cannot express. So it
		// is a runtime check, and its message has to teach the fix rather than merely
		// report a fault.
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [{ bucket: { ref: "b1" }, kind: "task", name: "x" }],
				description: "into a bucket nobody created",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("must name a create in the same call")
		expect(org.calls).toEqual([])
	})

	it("refuses a ref used as a different record kind", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [
					{ bucket: BUCKET, kind: "task", name: "first", ref: "t1" },
					{ bucket: { ref: "t1" }, kind: "task", name: "second" },
				],
				description: "use a task as a bucket",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("names a task, but this field needs a bucket")
		expect(org.calls).toEqual([])
	})

	it("refuses two creates sharing one ref", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [
					{ kind: "bucket", name: "A", ref: "b1" },
					{ kind: "bucket", name: "B", ref: "b1" },
				],
				description: "two buckets, one name for both",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("share the ref")
		expect(org.calls).toEqual([])
	})

	it("refuses a task update with no changed field", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				description: "change nothing",
				project: PROJECT,
				updates: [{ kind: "task", task: TASK }],
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("task update needs at least one changed field")
		expect(org.calls).toEqual([])
	})

	it("refuses out-of-range values and unknown keys", async () => {
		const client = await connect()

		const priority = await client.callTool({
			arguments: {
				creates: [{ bucket: BUCKET, kind: "task", name: "x", priority: 99 }],
				description: "d",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		expect(priority.isError).toBe(true)

		// 55 pins the common percentage-versus-fraction mistake.
		const progress = await client.callTool({
			arguments: {
				description: "d",
				project: PROJECT,
				updates: [{ kind: "task", progress: 55, task: TASK }],
			},
			name: "submit_operation_set",
		})
		expect(progress.isError).toBe(true)

		const typo = await client.callTool({
			arguments: {
				creates: [
					{ bucket: BUCKET, due: "2026-09-11T17:00:00Z", kind: "task", name: "x" },
				],
				description: "d",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		expect(typo.isError).toBe(true)
		expect(resultText(typo)).toContain("due")

		await client.close()
		expect(org.calls).toEqual([])
	})

	it("refuses more operations than one set can carry", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: Array.from({ length: 201 }, (_, at) => ({
					bucket: BUCKET,
					kind: "task",
					name: `Task ${at}`,
				})),
				description: "far too many",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("at most 200")
		expect(org.calls).toEqual([])
	})
})

describe("the refusals that come from the service itself", () => {
	it("says a bucket that does not exist does not exist", async () => {
		const client = await connect({ replaying: "reject-unknown-bucket" })
		const result = await client.callTool({
			arguments: {
				creates: [{ bucket: BUCKET, kind: "task", name: "unreachable" }],
				description: "create into a bucket that is not there",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("ScheduleAPI-AV-0006")
		expect(resultText(result)).toContain("does not exist")
	})

	it("reports a record that is not there as a PROJECT mismatch, because that is what it says", async () => {
		// The message names the all-zero project GUID and claims a mismatch. It means
		// NOT FOUND. Quoted verbatim rather than reworded: a friendlier sentence here
		// would be this package's invention, and an operator searching for the real text
		// would not find it.
		const client = await connect({ replaying: "reject-delete-unknown-task" })
		const result = await client.callTool({
			arguments: {
				deletes: [{ kind: "task", task: TASK }],
				description: "delete a task that is not there",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("ScheduleAPI-OV-0001")
		expect(resultText(result)).toContain("does not match the project id")
	})

	it("refuses to assign a task that has subtasks", async () => {
		const client = await connect({ replaying: "reject-assign-to-a-parent-task" })
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						kind: "assignment",
						member: PROJECT_TEAM_MEMBER,
						name: PROJECT_TEAM_MEMBER.name,
						task: TASK,
					},
				],
				description: "assign a task that has subtasks",
				project: PROJECT,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("Parent tasks cannot be assigned to")
	})

	it("fails loudly when the project itself is not there, before staging anything", async () => {
		const client = await connect({ replaying: "reject-unknown-project" })
		const result = await client.callTool({
			arguments: ONE_TASK_SUBMISSION,
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("Does Not Exist")
		expect(actionNames()).toEqual(["msdyn_CreateOperationSetV1"])
	})
})

describe("wait_for_operation_set", () => {
	it("reads once and answers when the caller wanted a glance, not a wait", async () => {
		const client = await connect({ replaying: "wait-zero-seconds" })
		const result = await client.callTool({
			arguments: { operation_set_id: mintedSetId(), seconds: 0 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(result.isError ?? false).toBe(false)
		expect(org.reads).toHaveLength(1)
	})

	it("stops at the first terminal answer instead of spending the window it was given", async () => {
		// The exact count belongs to recording timing. The contract is the range: more
		// than one read proves `executing` was not treated as terminal; fewer than the full
		// schedule proves the loop stopped when the terminal answer arrived.
		const client = await connect({ replaying: "update-task-description" })
		const result = await client.callTool({
			arguments: { operation_set_id: mintedSetId(), seconds: 45 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(payloadOf(result)).toEqual({ status: "completed" })
		expect(org.reads.length).toBeGreaterThan(1)
		expect(org.reads.length).toBeLessThan(readInstants(MAX_WAIT_SECONDS).length)
	}, 30_000) // It really sleeps the cadence between reads, and the count is the org's.

	it("says 'executing' when the window closes on a set that has not settled", async () => {
		// This intentionally sleeps the full window. The chain remains executing, so the
		// result must be the last observed status rather than a timeout.
		const client = await connect({
			replaying: "execute-refused-and-set-wedged-executing",
		})
		const result = await client.callTool({
			arguments: { operation_set_id: mintedSetId(), seconds: 8 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(result.isError ?? false).toBe(false)
		expect(payloadOf(result)).toEqual({ status: "executing" })
		expect(org.reads.length).toBeGreaterThan(1)
	}, 15_000)

	it("hands back the org's own not-found rather than a guess about what the id was", async () => {
		const client = await connect({ replaying: "wait-on-a-set-that-does-not-exist" })
		const result = await client.callTool({
			arguments: { operation_set_id: NAMES_NOTHING, seconds: 0 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("404 Not Found")
		expect(resultText(result)).toContain("Does Not Exist")
	})

	it("carries the caller's token on the read, not just on writes", async () => {
		const client = await connect({ replaying: "wait-zero-seconds" })
		await client.callTool({
			arguments: { operation_set_id: mintedSetId(), seconds: 0 },
			name: "wait_for_operation_set",
		})
		await client.close()
		for (const read of org.reads) expect(read.authorization).toBe(`Bearer ${accessToken}`)
	})
})

describe("when the caller has no Dataverse token", () => {
	it("says what a human has to do about it, and touches nothing", async () => {
		const client = await connect({ auth: null })
		const result = await client.callTool({
			arguments: ONE_TASK_SUBMISSION,
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("no linked Microsoft account")
		expect(org.calls).toEqual([])
		expect(org.reads).toEqual([])
	})
})
