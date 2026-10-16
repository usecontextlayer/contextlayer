// The cassette's shared vocabulary — the one data model and the one routing key
// that the recorder (record.ts), the replay (replay.ts), and the recorder-side
// gate must agree on. One definition each, because a drifting copy would let the
// writer, the server, and the gates disagree about what an interaction IS or what
// a collision IS.

import { z } from "zod"

export const authSchema = z.enum(["delegated", "none", "malformed"])
export type Auth = z.output<typeof authSchema>

export const jsonValueSchema = z.json()
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)
export const httpMethodSchema = z.enum(["GET", "POST"])
export const operationSetIdSchema = z.object({ OperationSetId: z.string().optional() })
export const requiredOperationSetIdSchema = z.object({
	OperationSetId: z.string().min(1),
})
export const operationSetReadSchema = z.object({
	msdyn_operationsetid: z.string().min(1),
	msdyn_status: z.literal([192350000, 192350001, 192350002, 192350003, 192350004]),
})

const requestSchema = z.discriminatedUnion("method", [
	z.strictObject({
		auth: authSchema,
		method: z.literal("GET"),
		path: z.string().min(1),
		prefer: z.string().optional(),
	}),
	z.strictObject({
		auth: authSchema,
		body: jsonObjectSchema,
		method: z.literal("POST"),
		path: z.string().min(1),
	}),
])

export const interactionSchema = z.strictObject({
	chain: z.string().min(1),
	request: requestSchema,
	response: z.strictObject({
		body: jsonValueSchema.optional(),
		status: z.number().int().min(100).max(599),
		statusText: z.string(),
	}),
	scenario: z.string().min(1),
})

export const cassetteSchema = z.strictObject({
	api: z.literal("dataverse-project-schedule-v9.2"),
	interactions: z.array(interactionSchema),
	note: z.string(),
	recordedBy: z.enum(["lib/cassette/record.ts", "lib/cassette/record-reads.ts"]),
})

/**
 * Which kind of credential an `Authorization` header carries.
 *
 * `auth` is part of the routing key, so the recorder and replay must share one
 * classification. Otherwise the replay cannot reach traffic the recorder accepted.
 */
export function authOf(header: string | undefined): Auth {
	const bearer = (header ?? "").replace("Bearer ", "")
	if (bearer === "") return "none"
	return bearer.split(".").length === 3 ? "delegated" : "malformed"
}

/**
 * What a Dataverse GUID looks like inside a cassette.
 *
 * A SOURCE STRING rather than a `RegExp`, so each caller builds its own and nobody shares
 * a `lastIndex` across modules. The guard in `approved-board.ts` deliberately keeps a
 * separate copy: it decides what may leave the process, which must not be weakened as a
 * side effect of an edit to something that only rewrites text. These two callers are
 * different — the recorder rewrites GUIDs and the gate detects the ones it missed, so
 * they must agree by construction.
 */
export const GUID_SOURCE =
	"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

/**
 * Everything that must never appear in a cassette, found in one pass over its bytes.
 *
 * The write-time and committed-bytes gates share this definition so a value accepted
 * during recording cannot be rejected only after the fixture is written. Returns one
 * sentence per class found, empty when clean.
 */
export function leaks(serialized: string): string[] {
	const found: string[] = []
	const jwt = serialized.match(/eyJ[A-Za-z0-9_-]{20,}/g)
	if (jwt) found.push(`${jwt.length} JWT-shaped strings`)
	const guid = serialized.match(new RegExp(GUID_SOURCE, "g"))
	if (guid) found.push(`${guid.length} unnormalized GUIDs, e.g. ${guid[0]}`)
	// Raw row versions must not survive normalization, including inside messages.
	const rowVersion = serialized.match(/W\/\\?"\d+\\?"/g)
	if (rowVersion) found.push(`${rowVersion.length} row versions, e.g. ${rowVersion[0]}`)
	const host = serialized.match(/\.(?:crm\d*|dynamics)\.com/g)
	if (host) found.push(`${host.length} org hostnames, e.g. ${host[0]}`)
	return found
}

/**
 * Scenario names used more than once.
 *
 * A scenario name is documentation, not the routing key. Reusing one makes the
 * recording ambiguous, so both gates require uniqueness.
 */
export function duplicateScenarios(
	interactions: readonly { scenario: string }[],
): Array<[string, number]> {
	const counts = new Map<string, number>()
	for (const i of interactions) counts.set(i.scenario, (counts.get(i.scenario) ?? 0) + 1)
	return [...counts].filter(([, count]) => count > 1)
}

export type Interaction = z.output<typeof interactionSchema>

/**
 * The routing key, within a chain. For a GET the path IS the identity — it carries
 * the record id and the `$select`, and two different `$select`s are two different
 * questions. For an action the path is only the verb, so the OperationSetId in the
 * body does the work. A create names no OperationSetId — it mints one — and
 * deliberately nothing else from its body is keyed: the chain a test replays
 * already chose which conversation this is, and a create's remaining fields
 * (`Description`, `ProjectId`) are the ones production can never reproduce
 * byte-for-byte.
 *
 * `auth` is part of the key because credentials can change the answer to an otherwise
 * identical request; omitting it would merge distinct questions into one response
 * sequence.
 */
export function keyOf(request: Interaction["request"]): string {
	const url = new URL(request.path, "https://recording.invalid/")
	url.searchParams.sort()
	const path = url.searchParams.has("$skiptoken")
		? request.path
		: decodeURIComponent(url.pathname.slice(1)) +
			(url.search ? `?${url.searchParams}` : "")
	const setId =
		request.method === "POST"
			? (operationSetIdSchema.parse(request.body).OperationSetId ?? "")
			: ""
	return `${request.method}|${path}|${request.auth}|${setId}|${request.method === "GET" ? (request.prefer ?? "") : ""}`
}

type Keyed = Pick<Interaction, "chain" | "request" | "scenario">
type Read = {
	request: { method: string; path: string }
	response: { body?: unknown; status: number }
}

/**
 * Every (chain, key) group answering more than ONE distinct request — the state
 * the replay cannot express, since it serves a key's responses as one sequence:
 * everything after the first request's answer is permanently unreachable. Defined
 * here, beside the key, so the recorder's per-interaction gate and the
 * committed-bytes gate cannot drift into two definitions of a collision.
 */
export function collisions(
	interactions: readonly Keyed[],
): Array<{ key: string; requests: number; scenarios: string[] }> {
	const grouped = new Map<string, Keyed[]>()
	for (const i of interactions) {
		const key = `${i.chain} :: ${keyOf(i.request)}`
		grouped.set(key, [...(grouped.get(key) ?? []), i])
	}
	return [...grouped].flatMap(([key, group]) => {
		const requests = new Set(group.map((i) => JSON.stringify(i.request)))
		return requests.size > 1
			? [{ key, requests: requests.size, scenarios: group.map((i) => i.scenario) }]
			: []
	})
}

/**
 * Every set-read path observed EXECUTING and later observed at a terminal
 * status — the recording's proof that the org was caught mid-flight, which is
 * the one property of a recording that is DISCOVERED rather than constructed.
 *
 * EXECUTING specifically, because it is the only state the production wait loop polls.
 * `open` does not earn another read, and a submitted receipt is already past it. Shared
 * so the write-time and committed-bytes gates cannot diverge.
 */
export function executingProgressions(interactions: readonly Read[]): string[] {
	const EXECUTING = 192350001
	const TERMINAL = new Set([192350002, 192350003, 192350004])
	const seenExecuting = new Set<string>()
	const progressed = new Set<string>()
	for (const i of interactions) {
		if (
			i.request.method !== "GET" ||
			!i.request.path.startsWith("msdyn_operationsets(") ||
			i.response.status < 200 ||
			i.response.status >= 300
		) {
			continue
		}
		const { msdyn_status: status } = operationSetReadSchema.parse(i.response.body)
		if (status === EXECUTING) seenExecuting.add(i.request.path)
		else if (TERMINAL.has(status) && seenExecuting.has(i.request.path)) {
			progressed.add(i.request.path)
		}
	}
	return [...progressed]
}
