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
// The caller's token names a Dataverse org; fetch routes only that origin to the
// local replay. These unsigned tokens exercise claim checks, not Microsoft validation.

import { readFileSync } from "node:fs"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { UnsecuredJWT } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Bindings } from "@/env"
import app from "@/index"
import { cassetteSchema } from "@/lib/cassette/interaction"
import {
	materializeRecording,
	type RecordedOrg,
	serveRecordedOrg,
} from "@/lib/cassette/replay"
import { MAX_WAIT_SECONDS, readInstants } from "@/lib/operation-set"

// Dataverse-SHAPED GUIDs: the `f011` third group is not an RFC-4122 version nibble,
// which is exactly how real msdyn_* ids look. Keep them non-RFC-4122: an RFC-4122
// exemplar here sails through a `z.uuid()` schema that many production GUIDs fail
// — a green suite over a broken write — and these fixtures are what pin `guid()`
// over `uuid()`.
const PROJECT = {
	msdyn_projectid: "9c8b7a65-4321-f011-8dcb-0a1b2c3d4e5f",
	msdyn_subject: "Gable",
}
const BUCKET = {
	msdyn_name: "GBLPBI02",
	msdyn_projectbucketid: "1f2e3d4c-5b6a-f011-9e8d-7c6b5a4f3e2d",
}
const TASK = {
	msdyn_projecttaskid: "5a4b3c2d-1e0f-f011-b7a6-9d8c7b6a5f4e",
	msdyn_subject: "Follow up on Gable PBI",
}
const LABEL = {
	msdyn_projectlabelid: "3c2d1e0f-4b5a-f011-8c7b-6a5f4e3d2c1b",
	msdyn_projectlabeltext: "Blocked",
}
const PROJECT_TEAM_MEMBER = {
	msdyn_name: "Komal Farooq",
	msdyn_projectteamid: "7f6e5d4c-3b2a-f011-9a8b-1c2d3e4f5a6b",
}
const TASK_LABEL_LINK = {
	msdyn_projecttasktolabelid: "2d1e0f3c-5a4b-f011-7b6a-4e3d2c1b0f9e",
}
const ASSIGNMENT = {
	msdyn_resourceassignmentid: "8a9b0c1d-2e3f-f011-4a5b-6c7d8e9f0a1b",
}

const ONE_TASK_SUBMISSION = {
	creates: [
		{
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
			"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
			msdyn_projecttaskid: TASK.msdyn_projecttaskid,
			msdyn_subject: TASK.msdyn_subject,
		},
	],
	Description: "Add the Gable follow-up",
	ProjectId: PROJECT.msdyn_projectid,
}

const NAMES_NOTHING = "{{unknownTaskId}}"

const readAudience = "https://planner-test.crm.dynamics.com"
const readRecording = materializeRecording(
	cassetteSchema.parse(
		JSON.parse(
			readFileSync(new URL("./__goldens__/records.json", import.meta.url), "utf8"),
		),
	),
	readAudience,
)
const recordedRead = (chain: string) =>
	readRecording.interactions.find((interaction) => interaction.chain === chain)?.response
		.body as Record<string, unknown>
const recordedTaskId = recordedRead("records-single").msdyn_projecttaskid as string

let org: RecordedOrg
let accessToken: string
const networkFetch = globalThis.fetch

/**
 * Stand up the recorded org and drive the planner Worker's HTTP entrypoint.
 * `replaying` names the recorded chain this test drives; omitted only by tests that
 * touch no Dataverse traffic.
 */
async function connect(
	options: { replaying?: string; audience?: string } = {},
): Promise<Client> {
	const audience = options.audience ?? readAudience
	org = await serveRecordedOrg({ audience, replaying: options.replaying })
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		if (url.origin !== audience) throw new Error(`Unrecorded org: ${url.origin}`)
		return networkFetch(new URL(url.pathname + url.search, org.url), request)
	})
	const bindings = {
		MICROSOFT_CLIENT_ID: "aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11",
		MICROSOFT_CLIENT_SECRET: "test-only-secret",
	} satisfies Bindings
	accessToken = new UnsecuredJWT({
		appid: bindings.MICROSOFT_CLIENT_ID,
		scp: "user_impersonation",
	})
		.setAudience(audience)
		.setExpirationTime("1h")
		.encode()

	const client = new Client({ name: "test-caller", version: "1.0.0" })
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://planner.example/mcp"), {
			fetch: async (input, init) => app.fetch(new Request(input, init), bindings),
			requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
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
		unknown
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
	vi.unstubAllGlobals()
	await org?.close()
})

describe("the advertised surface", () => {
	it("exposes record retrieval and continuation alongside submit and wait", async () => {
		const client = await connect()
		const tools = await client.listTools()
		await client.close()
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"retrieve_records",
			"retrieve_records_next_link",
			"submit_operation_set",
			"wait_for_operation_set",
		])
	})

	it("advertises two read-only tools with distinct native inputs", async () => {
		const client = await connect()
		const { tools } = await client.listTools()
		await client.close()

		const retrieve = tools.find((tool) => tool.name === "retrieve_records")
		const next = tools.find((tool) => tool.name === "retrieve_records_next_link")
		for (const tool of [retrieve, next]) {
			expect(tool?.annotations?.readOnlyHint).toBe(true)
			expect(tool?.inputSchema).toMatchObject({
				additionalProperties: false,
				type: "object",
			})
		}
		expect(retrieve?.inputSchema.required).toEqual(["entity_set"])
		expect(retrieve?.inputSchema.properties?.entity_set).toMatchObject({
			enum: expect.arrayContaining([
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
			]),
		})
		expect(retrieve?.inputSchema.properties?.entity_set).toHaveProperty("enum.length", 12)
		expect(Object.keys(retrieve?.inputSchema.properties ?? {}).sort()).toEqual([
			"$apply",
			"$count",
			"$expand",
			"$filter",
			"$orderby",
			"$select",
			"$top",
			"entity_set",
			"id",
		])
		for (const option of [
			"$select",
			"$filter",
			"$orderby",
			"$top",
			"$expand",
			"$apply",
			"$count",
			"id",
		]) {
			expect(retrieve?.inputSchema.properties?.[option]).toMatchObject({ type: "string" })
		}
		expect(next?.inputSchema.required).toEqual(["next_link"])
		expect(Object.keys(next?.inputSchema.properties ?? {})).toEqual(["next_link"])
		expect(next?.inputSchema.properties?.next_link).toMatchObject({ type: "string" })
	})

	it("advertises optional native create IDs without a fixed default", async () => {
		const client = await connect()
		const { tools } = await client.listTools()
		await client.close()

		const submit = tools.find((tool) => tool.name === "submit_operation_set")?.inputSchema
		const creates = submit?.properties?.creates as {
			items: {
				oneOf: Array<{
					properties: Record<string, { const?: string; default?: unknown }>
					required: string[]
				}>
			}
		}
		for (const [type, primaryId] of [
			["Microsoft.Dynamics.CRM.msdyn_projecttask", "msdyn_projecttaskid"],
			["Microsoft.Dynamics.CRM.msdyn_projectbucket", "msdyn_projectbucketid"],
			["Microsoft.Dynamics.CRM.msdyn_projecttasktolabel", "msdyn_projecttasktolabelid"],
			["Microsoft.Dynamics.CRM.msdyn_resourceassignment", "msdyn_resourceassignmentid"],
		] as const) {
			const variant = creates.items.oneOf.find(
				(branch) => branch.properties["@odata.type"]?.const === type,
			)
			expect(variant?.properties).toHaveProperty(primaryId)
			expect(variant?.required).not.toContain(primaryId)
			expect(variant?.properties[primaryId]).not.toHaveProperty("default")
		}
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
		expect(kinds).toContain("msdyn_projecttask")
		expect(kinds).toContain("msdyn_resourceassignment")
		expect(kinds).not.toContain("msdyn_projectbucket")
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
		expect(Object.keys(strictness).length).toBeGreaterThan(1)
		expect(Object.values(strictness).every((value) => value === false)).toBe(true)
	})
})

describe("native record retrieval", () => {
	it.each([
		{
			args: {
				$select: "msdyn_projectid,msdyn_subject",
				$top: "2",
				entity_set: "msdyn_projects",
			},
			chain: "records-projects",
			purpose: "project discovery with native metadata",
		},
		{
			args: {
				$count: "true",
				$filter: "msdyn_progress lt 1",
				$orderby: "msdyn_projecttaskid",
				$select:
					"msdyn_projecttaskid,msdyn_subject,msdyn_progress,_msdyn_project_value,statecode",
				$top: "2",
				entity_set: "msdyn_projecttasks",
			},
			chain: "records-query",
			purpose: "filtered and ordered tasks with counts and formatted values",
		},
		{
			args: { entity_set: "msdyn_projecttasks", id: recordedTaskId },
			chain: "records-single",
			purpose: "an individual record with custom columns and nulls",
		},
		{
			args: {
				$expand: "msdyn_project($select=msdyn_projectid,msdyn_subject)",
				$select: "msdyn_projecttaskid",
				entity_set: "msdyn_projecttasks",
				id: recordedTaskId,
			},
			chain: "records-expand",
			purpose: "native related-record expansion",
		},
		{
			args: {
				$apply: "groupby((msdyn_progress),aggregate($count as n))",
				entity_set: "msdyn_projecttasks",
			},
			chain: "records-aggregate",
			purpose: "native grouping, aggregate aliases and formatted values",
		},
	])("preserves Microsoft's JSON for $purpose", async ({ chain, args }) => {
		const client = await connect({ replaying: chain })
		const result = await client.callTool({ arguments: args, name: "retrieve_records" })
		await client.close()
		expect(result.isError ?? false).toBe(false)
		expect(payloadOf(result)).toEqual(recordedRead(chain))
	})

	it.each([
		{
			chain: "records-pages",
			initial: { entity_set: "msdyn_projecttasks" },
			nextLinkField: "@odata.nextLink",
		},
		{
			chain: "records-expanded-pages",
			initial: {
				entity_set: "msdyn_projects",
				id: recordedRead("records-expanded-pages").msdyn_projectid,
			},
			nextLinkField: "msdyn_msdyn_project_msdyn_projecttask_project@odata.nextLink",
		},
	])(
		"$chain returns one page, then follows its native link to the final page",
		async ({ chain, initial, nextLinkField }) => {
			const client = await connect({ replaying: chain })
			const pages = readRecording.interactions.filter(
				(interaction) => interaction.chain === chain,
			)
			// The recorder requested maxpagesize=1 to observe real continuation without
			// adding a page-size input to the production tool.
			const query = new URL(
				pages[0]?.request.path ?? "",
				`${readAudience}/api/data/v9.2/`,
			).searchParams
			const first = await client.callTool({
				arguments: { ...initial, ...Object.fromEntries(query) },
				name: "retrieve_records",
			})
			expect(first.isError ?? false).toBe(false)
			const firstPage = payloadOf(first)
			expect(firstPage).toEqual(pages[0]?.response.body)
			expect(firstPage[nextLinkField]).toEqual(expect.any(String))
			const next = await client.callTool({
				arguments: { next_link: firstPage[nextLinkField] },
				name: "retrieve_records_next_link",
			})
			await client.close()
			expect(next.isError ?? false).toBe(false)
			expect(payloadOf(next)).toEqual(pages[1]?.response.body)
			expect(payloadOf(next)).not.toHaveProperty("@odata.nextLink")
		},
	)
})

describe("read boundaries", () => {
	it("refuses a Dataverse root outside Planner", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: { entity_set: "systemusers" },
			name: "retrieve_records",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("entity_set")
	})

	it.each([
		"https://another-org.crm.dynamics.com/api/data/v9.2/msdyn_projecttasks?$skiptoken=opaque",
		"https://planner-test.crm.dynamics.com/api/data/v9.2/systemusers?$skiptoken=opaque",
	])(
		"refuses a continuation outside the connected Planner boundary: %s",
		async (next_link) => {
			const client = await connect()
			const result = await client.callTool({
				arguments: { next_link },
				name: "retrieve_records_next_link",
			})
			await client.close()
			expect(result.isError).toBe(true)
			expect(resultText(result)).toContain(
				"next_link must target a Planner entity set in the connected Dataverse environment",
			)
		},
	)
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
		expect(payloadOf(result).OperationSetId).toBe(org.calls[2]?.body.OperationSetId)
		// The description the caller wrote is what the set carries, because it is also
		// what the human approving the call reads.
		expect(org.calls[0]?.body).toEqual({
			Description: "Add the Gable follow-up",
			ProjectId: PROJECT.msdyn_projectid,
		})
		expect(stagedEntitiesForAction("msdyn_PssCreateV2")[0]).toMatchObject({
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_outlinelevel: 1,
			"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
			"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
			msdyn_projecttaskid: TASK.msdyn_projecttaskid,
			msdyn_subject: TASK.msdyn_subject,
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
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_description: "What the client asked for, and by when.",
						msdyn_finish: "2026-09-11T17:00:00Z",
						msdyn_priority: 7,
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_start: "2026-09-07T09:00:00Z",
						msdyn_subject: TASK.msdyn_subject,
					},
				],
				Description: "Add the Gable follow-up with its dates",
				ProjectId: PROJECT.msdyn_projectid,
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
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
						msdyn_name: "Northbay",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						ref: "b1",
					},
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": { ref: "b1" },
						msdyn_subject: "Northbay - DLP policy doc",
					},
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": { ref: "b1" },
						msdyn_subject: "Northbay - training deck",
					},
				],
				Description: "Add the Northbay bucket and Tuesday's two follow-ups",
				ProjectId: PROJECT.msdyn_projectid,
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
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "New from the call",
					},
				],
				Description: "Add one, rename one, drop one",
				deletes: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_projecttaskid: TASK.msdyn_projecttaskid,
					},
				],
				ProjectId: PROJECT.msdyn_projectid,
				updates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_projecttaskid: TASK.msdyn_projecttaskid,
						msdyn_subject: "Renamed",
					},
				],
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

	it("preserves native bucket fields when renaming an existing bucket", async () => {
		const client = await connect({ replaying: "update-bucket-name" })
		const update = {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
			msdyn_name: "ZZ Cassette Bucket Renamed",
			msdyn_projectbucketid: BUCKET.msdyn_projectbucketid,
		}
		const result = await client.callTool({
			arguments: {
				Description: "Rename the bucket",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [update],
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		expect(stagedEntitiesForAction("msdyn_PssUpdateV2")).toEqual([update])
	})

	it("preserves native label fields when renaming an existing label", async () => {
		const client = await connect({ replaying: "rename-label" })
		const update = {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectlabel",
			msdyn_projectlabelid: LABEL.msdyn_projectlabelid,
			msdyn_projectlabeltext: "ZZ Cassette Label",
		}
		const result = await client.callTool({
			arguments: {
				Description: "Name the label",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [update],
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		expect(stagedEntitiesForAction("msdyn_PssUpdateV2")).toEqual([update])
	})

	it("resolves a same-set task update's native identity to its created GUID", async () => {
		const client = await connect({
			replaying: "update-a-task-created-in-the-same-set",
		})
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "ZZ cassette created-then-updated",
						ref: "task",
					},
				],
				Description: "Create the task and amend it",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_progress: 0.5,
						msdyn_projecttaskid: { ref: "task" },
						msdyn_subject: "ZZ cassette created-then-updated (amended)",
					},
				],
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		const createdId = (payloadOf(result).created as Record<string, string>).task
		expect(createdId).toEqual(expect.any(String))
		const created = stagedEntitiesForAction("msdyn_PssCreateV2")[0]
		expect(created?.msdyn_projecttaskid).toBe(createdId)
		expect(created).not.toHaveProperty("ref")
		expect(stagedEntitiesForAction("msdyn_PssUpdateV2")).toEqual([
			{
				"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
				msdyn_progress: 0.5,
				msdyn_projecttaskid: createdId,
				msdyn_subject: "ZZ cassette created-then-updated (amended)",
			},
		])
	})

	it("resolves a same-set bucket update's native identity to its created GUID", async () => {
		const client = await connect({
			replaying: "rename-a-bucket-created-in-the-same-set",
		})
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
						msdyn_name: "ZZ Cassette Born Named",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						ref: "bucket",
					},
				],
				Description: "Create the bucket and rename it",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
						msdyn_name: "ZZ Cassette Renamed Same Set",
						msdyn_projectbucketid: { ref: "bucket" },
					},
				],
			},
			name: "submit_operation_set",
		})
		await client.close()

		expect(result.isError ?? false).toBe(false)
		const createdId = (payloadOf(result).created as Record<string, string>).bucket
		expect(createdId).toEqual(expect.any(String))
		const created = stagedEntitiesForAction("msdyn_PssCreateV2")[0]
		expect(created?.msdyn_projectbucketid).toBe(createdId)
		expect(created).not.toHaveProperty("ref")
		expect(stagedEntitiesForAction("msdyn_PssUpdateV2")).toEqual([
			{
				"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
				msdyn_name: "ZZ Cassette Renamed Same Set",
				msdyn_projectbucketid: createdId,
			},
		])
	})

	it("stages many tasks as one collection, not one set each", async () => {
		const client = await connect({ replaying: "create-many-tasks" })
		await client.callTool({
			arguments: {
				creates: [1, 2, 3].map((n) => ({
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
					msdyn_subject: `Batch ${n}`,
				})),
				Description: "Three at once",
				ProjectId: PROJECT.msdyn_projectid,
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
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
						"msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${LABEL.msdyn_projectlabelid})`,
						"msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${TASK.msdyn_projecttaskid})`,
					},
				],
				Description: "Mark it blocked",
				ProjectId: PROJECT.msdyn_projectid,
			},
			name: "submit_operation_set",
		})
		// The navigation properties are CAPITALISED and Dataverse matches them
		// case-sensitively — lowercase here fails every attach, which is why the exact
		// keys are pinned rather than the values alone.
		expect(stagedEntitiesForAction("msdyn_PssCreateV2")[0]).toMatchObject({
			"msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${LABEL.msdyn_projectlabelid})`,
			"msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${TASK.msdyn_projecttaskid})`,
		})
		await attach.close()
		await org.close()

		const detach = await connect({ replaying: "detach-label" })
		await detach.callTool({
			arguments: {
				Description: "Unblock it",
				deletes: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
						msdyn_projecttasktolabelid: TASK_LABEL_LINK.msdyn_projecttasktolabelid,
					},
				],
				ProjectId: PROJECT.msdyn_projectid,
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
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
						msdyn_name: PROJECT_TEAM_MEMBER.msdyn_name,
						"msdyn_projectid@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${PROJECT_TEAM_MEMBER.msdyn_projectteamid})`,
						"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${TASK.msdyn_projecttaskid})`,
					},
				],
				Description: "Give it to Komal",
				ProjectId: PROJECT.msdyn_projectid,
			},
			name: "submit_operation_set",
		})
		await client.close()
		const staged = stagedEntitiesForAction("msdyn_PssCreateV2")[0]
		expect(staged).toMatchObject({
			msdyn_name: PROJECT_TEAM_MEMBER.msdyn_name,
			"msdyn_projectid@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
			"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${PROJECT_TEAM_MEMBER.msdyn_projectteamid})`,
			"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${TASK.msdyn_projecttaskid})`,
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
				Description: "Take it off Komal",
				deletes: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
						msdyn_resourceassignmentid: ASSIGNMENT.msdyn_resourceassignmentid,
					},
				],
				ProjectId: PROJECT.msdyn_projectid,
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
			msdyn_resourceassignmentid: ASSIGNMENT.msdyn_resourceassignmentid,
		})
	})
})

describe("arguments the tool refuses before any Dataverse traffic", () => {
	it("refuses a submission with nothing in it", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [],
				Description: "nothing",
				deletes: [],
				ProjectId: PROJECT.msdyn_projectid,
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
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_finish: "2026-08-28",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "x",
					},
				],
				Description: "due Friday",
				ProjectId: PROJECT.msdyn_projectid,
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
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_finish: "2026-02-30T17:00:00Z",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "x",
					},
				],
				Description: "an impossible date",
				ProjectId: PROJECT.msdyn_projectid,
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
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_finish: "2026-09-11T17:00:00.10Z",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_start: "2026-09-11T17:00:00.1Z",
						msdyn_subject: "x",
					},
				],
				Description: "equal instants",
				ProjectId: PROJECT.msdyn_projectid,
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
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_finish: "2026-09-11T17:00:00.1Z",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_start: "2026-09-11T17:00:00.11Z",
						msdyn_subject: "x",
					},
				],
				Description: "an inverted subsecond range",
				ProjectId: PROJECT.msdyn_projectid,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain("msdyn_finish is before msdyn_start")
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
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": { ref: "b1" },
						msdyn_subject: "x",
					},
				],
				Description: "into a bucket nobody created",
				ProjectId: PROJECT.msdyn_projectid,
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
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "first",
						ref: "t1",
					},
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": { ref: "t1" },
						msdyn_subject: "second",
					},
				],
				Description: "use a task as a bucket",
				ProjectId: PROJECT.msdyn_projectid,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(resultText(result)).toContain(
			"names Microsoft.Dynamics.CRM.msdyn_projecttask, but this field needs Microsoft.Dynamics.CRM.msdyn_projectbucket",
		)
		expect(org.calls).toEqual([])
	})

	it("refuses two creates sharing one ref", async () => {
		const client = await connect()
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
						msdyn_name: "A",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						ref: "b1",
					},
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
						msdyn_name: "B",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						ref: "b1",
					},
				],
				Description: "two buckets, one name for both",
				ProjectId: PROJECT.msdyn_projectid,
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
				Description: "change nothing",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_projecttaskid: TASK.msdyn_projecttaskid,
					},
				],
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
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_priority: 99,
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "x",
					},
				],
				Description: "d",
				ProjectId: PROJECT.msdyn_projectid,
			},
			name: "submit_operation_set",
		})
		expect(priority.isError).toBe(true)

		// 55 pins the common percentage-versus-fraction mistake.
		const progress = await client.callTool({
			arguments: {
				Description: "d",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_progress: 55,
						msdyn_projecttaskid: TASK.msdyn_projecttaskid,
					},
				],
			},
			name: "submit_operation_set",
		})
		expect(progress.isError).toBe(true)

		const typo = await client.callTool({
			arguments: {
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						due: "2026-09-11T17:00:00Z",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "x",
					},
				],
				Description: "d",
				ProjectId: PROJECT.msdyn_projectid,
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
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
					msdyn_subject: `Task ${at}`,
				})),
				Description: "far too many",
				ProjectId: PROJECT.msdyn_projectid,
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
	it("keeps the minted receipt and Microsoft error together after execute rejection", async () => {
		const client = await connect({
			replaying: "execute-refused-and-set-wedged-executing",
		})
		const result = await client.callTool({
			arguments: {
				Description: "Update task progress",
				ProjectId: PROJECT.msdyn_projectid,
				updates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_progress: 0.5,
						msdyn_projecttaskid: TASK.msdyn_projecttaskid,
					},
				],
			},
			name: "submit_operation_set",
		})
		expect(result.isError).toBe(true)
		const failure = payloadOf(result)
		expect(failure.OperationSetId).toBe(mintedSetId())
		expect(failure.error).toContain("msdyn_ExecuteOperationSetV1 failed: 403 Forbidden")
		expect(failure.error).toContain("0x80040220")
		expect(failure.error).toContain("prvCreatemsdyn_psserrorlog")

		const status = await client.callTool({
			arguments: { OperationSetId: failure.OperationSetId, seconds: 0 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(status.isError ?? false).toBe(false)
		expect(payloadOf(status)).toMatchObject({ msdyn_status: 192350001 })
	})

	it("says a bucket that does not exist does not exist", async () => {
		const client = await connect({ replaying: "reject-unknown-bucket" })
		const result = await client.callTool({
			arguments: {
				creates: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						"msdyn_project@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET.msdyn_projectbucketid})`,
						msdyn_subject: "unreachable",
					},
				],
				Description: "create into a bucket that is not there",
				ProjectId: PROJECT.msdyn_projectid,
			},
			name: "submit_operation_set",
		})
		await client.close()
		expect(result.isError).toBe(true)
		expect(payloadOf(result).OperationSetId).toBe(mintedSetId())
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
				Description: "delete a task that is not there",
				deletes: [
					{
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_projecttaskid: TASK.msdyn_projecttaskid,
					},
				],
				ProjectId: PROJECT.msdyn_projectid,
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
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
						msdyn_name: PROJECT_TEAM_MEMBER.msdyn_name,
						"msdyn_projectid@odata.bind": `/msdyn_projects(${PROJECT.msdyn_projectid})`,
						"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${PROJECT_TEAM_MEMBER.msdyn_projectteamid})`,
						"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${TASK.msdyn_projecttaskid})`,
					},
				],
				Description: "assign a task that has subtasks",
				ProjectId: PROJECT.msdyn_projectid,
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
	it.each([
		"https://planner-test.crm.dynamics.com",
		"https://another-org.crm3.dynamics.com",
	])(
		"reads once from token audience %s without deployment org configuration",
		async (audience) => {
			const client = await connect({ audience, replaying: "wait-zero-seconds" })
			const result = await client.callTool({
				arguments: { OperationSetId: mintedSetId(), seconds: 0 },
				name: "wait_for_operation_set",
			})
			await client.close()
			expect(result.isError ?? false).toBe(false)
			expect(org.reads).toHaveLength(1)
			expect(payloadOf(result)).toMatchObject({
				msdyn_operationsetid: mintedSetId(),
				msdyn_status: expect.any(Number),
			})
			expect(org.reads[0]?.authorization).toBe(`Bearer ${accessToken}`)
		},
	)

	it("stops at the first terminal answer instead of spending the window it was given", async () => {
		// The exact count belongs to recording timing. The contract is the range: more
		// than one read proves `executing` was not treated as terminal; fewer than the full
		// schedule proves the loop stopped when the terminal answer arrived.
		const client = await connect({ replaying: "update-task-description" })
		const result = await client.callTool({
			arguments: { OperationSetId: mintedSetId(), seconds: 45 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(payloadOf(result)).toMatchObject({ msdyn_status: 192350003 })
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
			arguments: { OperationSetId: mintedSetId(), seconds: 8 },
			name: "wait_for_operation_set",
		})
		await client.close()
		expect(result.isError ?? false).toBe(false)
		expect(payloadOf(result)).toMatchObject({ msdyn_status: 192350001 })
		expect(org.reads.length).toBeGreaterThan(1)
	}, 15_000)

	it("hands back the org's own not-found rather than a guess about what the id was", async () => {
		const client = await connect({ replaying: "wait-on-a-set-that-does-not-exist" })
		const result = await client.callTool({
			arguments: { OperationSetId: NAMES_NOTHING, seconds: 0 },
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
			arguments: { OperationSetId: mintedSetId(), seconds: 0 },
			name: "wait_for_operation_set",
		})
		await client.close()
		for (const read of org.reads) expect(read.authorization).toBe(`Bearer ${accessToken}`)
	})
})
