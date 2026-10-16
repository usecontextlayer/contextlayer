// READ ONLY. Capture native Dataverse reads with an operator-supplied delegated token.
// From the repository root:
//
// CTX_DATAVERSE_ORG_URL=https://<org>.crm.dynamics.com CTX_DATAVERSE_TOKEN_FILE=<file> \
//   pnpm exec tsx --tsconfig packages/mcp-microsoft-planner-premium/tsconfig.json \
//   packages/mcp-microsoft-planner-premium/lib/cassette/record-reads.ts
//
// Requires the first two incomplete tasks ordered by ID to share a readable project.
// Discovery establishes these prerequisites without creating or updating customer data.
// Only this script writes records.json. Never hand-edit it. Customer text, GUIDs,
// timestamps, row versions and the org are normalized in memory before persistence.
// Pagination uses a RECORDING-ONLY maxpagesize=1 preference; the product uses the
// service default. Both pages request formatted values. Run Biome on generated JSON.

import { readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"
import { parseReadRecorderEnv } from "@/env"
import {
	cassetteSchema,
	collisions,
	duplicateScenarios,
	GUID_SOURCE,
	type Interaction,
	interactionSchema,
	jsonObjectSchema,
	type jsonValueSchema,
	leaks,
} from "@/lib/cassette/interaction"

const env = parseReadRecorderEnv()
const annotations =
	'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'
type Json = z.output<typeof jsonValueSchema>
const interactions: Interaction[] = []
const identifiers = new Map<string, string>()
const texts = new Map<string, string>()
const org = new URL(env.CTX_DATAVERSE_ORG_URL).origin

function normalizeProtocol(value: string): string {
	return value
		.replaceAll(org, "{{org}}")
		.replace(new RegExp(GUID_SOURCE, "g"), (id) => {
			const key = id.toLowerCase()
			if (!identifiers.has(key)) identifiers.set(key, `{{guid${identifiers.size + 1}}}`)
			return identifiers.get(key) as string
		})
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "{{timestamp}}")
}

function normalize(value: Json, key = ""): Json {
	if (key === "versionnumber" && typeof value === "number") return 0
	if (Array.isArray(value)) return value.map((item) => normalize(item, key))
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [name, normalize(item, name)]),
		)
	}
	if (typeof value !== "string" || value === "") return value
	if (key === "@odata.etag") return 'W/"{{etag}}"'
	if (key.startsWith("@odata.") || key.endsWith("@odata.nextLink"))
		return normalizeProtocol(value)
	if (new RegExp(`^${GUID_SOURCE}$`).test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value))
		return normalizeProtocol(value)
	if (!texts.has(value)) texts.set(value, `{{text${texts.size + 1}}}`)
	return texts.get(value) as string
}

function query(entity: string, options: Record<string, string>): string {
	return `${entity}?${new URLSearchParams(options)}`
}

async function read(
	path: string,
	chain: string,
	pageSize?: number,
): Promise<Record<string, Json>> {
	const response = await fetch(`${org}/api/data/v9.2/${path}`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${readFileSync(env.CTX_DATAVERSE_TOKEN_FILE, "utf8").trim()}`,
			Prefer:
				pageSize === undefined
					? annotations
					: `${annotations},odata.maxpagesize=${pageSize}`,
		},
	})
	if (!response.ok)
		throw new Error(`Dataverse read failed with HTTP ${response.status} in ${chain}`)
	const data = jsonObjectSchema.parse(await response.json())
	interactions.push(
		interactionSchema.parse({
			chain,
			request: {
				auth: "delegated",
				method: "GET",
				path: normalizeProtocol(path),
				prefer: annotations,
			},
			response: {
				body: normalize(data),
				status: response.status,
				statusText: response.statusText,
			},
			scenario: `${chain} · ${interactions.filter((item) => item.chain === chain).length + 1}`,
		}),
	)
	return data
}

const tasksQuery = query("msdyn_projecttasks", {
	$count: "true",
	$filter: "msdyn_progress lt 1",
	$orderby: "msdyn_projecttaskid",
	$select:
		"msdyn_projecttaskid,msdyn_subject,msdyn_progress,_msdyn_project_value,statecode",
	$top: "2",
})
const tasks = await read(tasksQuery, "records-query")
const rows = z
	.array(
		z
			.object({ _msdyn_project_value: z.guid(), msdyn_projecttaskid: z.guid() })
			.passthrough(),
	)
	.length(2)
	.parse(tasks.value)
if (
	!Object.keys(rows[0] as object).some((key) =>
		key.endsWith("@OData.Community.Display.V1.FormattedValue"),
	)
)
	throw new Error("Readable tasks did not include formatted annotations")
const first = rows[0] as (typeof rows)[number]
if (rows.some((row) => row._msdyn_project_value !== first._msdyn_project_value))
	throw new Error(
		"Recording requires the first two incomplete tasks ordered by ID to share one readable project",
	)
await read(
	query("msdyn_projects", { $select: "msdyn_projectid,msdyn_subject", $top: "2" }),
	"records-projects",
)
await read(`msdyn_projecttasks(${first.msdyn_projecttaskid})`, "records-single")
const expanded = await read(
	query(`msdyn_projecttasks(${first.msdyn_projecttaskid})`, {
		$expand: "msdyn_project($select=msdyn_projectid,msdyn_subject)",
		$select: "msdyn_projecttaskid",
	}),
	"records-expand",
)
z.object({
	msdyn_project: z.object({ msdyn_projectid: z.guid(), msdyn_subject: z.string() }),
}).parse(expanded)
await read(
	query("msdyn_projecttasks", {
		$apply: "groupby((msdyn_progress),aggregate($count as n))",
	}),
	"records-aggregate",
)
const pagePath = query("msdyn_projecttasks", {
	$filter: rows
		.map((row) => `msdyn_projecttaskid eq ${row.msdyn_projecttaskid}`)
		.join(" or "),
	$orderby: "msdyn_projecttaskid",
	$select: "msdyn_projecttaskid,msdyn_subject",
})
const page1 = await read(pagePath, "records-pages", 1)
const nextLink = z.string().url().parse(page1["@odata.nextLink"])
const next = new URL(nextLink)
if (next.origin !== org) throw new Error("Dataverse continuation changed environment")
const page2 = await read(
	next.pathname.replace("/api/data/v9.2/", "") + next.search,
	"records-pages",
	1,
)
if (page2["@odata.nextLink"] !== undefined)
	throw new Error("Expected the second of two task pages to be terminal")
z.array(jsonObjectSchema).length(1).parse(page1.value)
z.array(jsonObjectSchema).length(1).parse(page2.value)

const navigation = "msdyn_msdyn_project_msdyn_projecttask_project"
const expandedPage = await read(
	query(`msdyn_projects(${first._msdyn_project_value})`, {
		$expand: `${navigation}($select=msdyn_projecttaskid;$filter=${rows.map((row) => `msdyn_projecttaskid eq ${row.msdyn_projecttaskid}`).join(" or ")})`,
		$select: "msdyn_projectid",
	}),
	"records-expanded-pages",
	1,
)
const expandedNext = new URL(
	z.string().url().parse(expandedPage[`${navigation}@odata.nextLink`]),
)
if (expandedNext.origin !== org)
	throw new Error("Expanded continuation changed environment")
const expandedLast = await read(
	expandedNext.pathname.replace("/api/data/v9.2/", "") + expandedNext.search,
	"records-expanded-pages",
	1,
)
z.array(jsonObjectSchema).length(1).parse(expandedPage[navigation])
z.array(jsonObjectSchema).length(1).parse(expandedLast.value)
if (expandedLast["@odata.nextLink"] !== undefined)
	throw new Error("Expected expanded task continuation to be terminal")

const cassette = cassetteSchema.parse({
	api: "dataverse-project-schedule-v9.2",
	interactions,
	note: "Recorded native Dataverse GETs with lib/cassette/record-reads.ts. Never hand-edit: rerun that script. Customer text and identifiers normalized in memory. Paging conversations used recording-only odata.maxpagesize=1, omitted from the replay key; production uses default page size. Every request asked for formatted-value annotations. Existing readable records establish preconditions; no customer writes.",
	recordedBy: "lib/cassette/record-reads.ts",
})
const serialized = `${JSON.stringify(cassette, null, "\t")}\n`
const failures = [
	...leaks(serialized),
	...collisions(interactions),
	...duplicateScenarios(interactions),
]
if (failures.length)
	throw new Error(`Recording audit failed: ${JSON.stringify(failures)}`)
writeFileSync(new URL("../__goldens__/records.json", import.meta.url), serialized)
console.log(
	`Recorded ${interactions.length} normalized GETs in ${new Set(interactions.map((item) => item.chain)).size} conversations.`,
)
