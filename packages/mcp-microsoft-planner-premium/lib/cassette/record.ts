// Capture and normalize real Project Schedule API traffic by driving the production
// client. The replay routes on request identity, so a hand-written request sequence
// could stay green after production made it unreachable; using `submitOperationSet`
// and `waitForOperationSet` keeps the fixture reachable by construction.
//
// ===========================================================================
// THIS SCRIPT WRITES TO A CUSTOMER'S PRODUCTION ORGANISATION.
//
// `approved-board.ts` confines every request to one board and deliberately offers no
// runtime destination configuration. The organisation contains live customer data;
// there is no sandbox.
//
// Run it as:
//
//   CTX_DATAVERSE_TOKEN_FILE=/path/to/token npx tsx lib/cassette/record.ts
//
// The token identifies the caller; the guard independently decides which records that
// caller may name.
// ===========================================================================
//
// THEN RUN `pnpm run format.fix` FROM THE REPO ROOT. Biome canonicalizes the generated
// key order, and `format.verify` rejects the raw output.
//
// Recording contract:
//   - Every fixture is produced by this script. NEVER hand-edit a fixture; change
//     the script and re-run.
//   - Normalization happens as each response is recorded, so an unnormalized value
//     never reaches disk. One thing is DROPPED rather than normalized —
//     `@odata.etag` — because we model no concurrency mechanism and a recorded row
//     version would invite a design nobody has decided to have.
//   - Every mutable record a chain studies is constructed by this script. The scratch
//     project, bucket, label and team member are fixed pre-existing scaffolding.
//     Polling state is observed, and the final gate requires an executing-to-terminal
//     progression.
//   - A chain is a REPLAY UNIT selected with `serveRecordedOrg({ replaying })`. A
//     submitted set and the reads that follow it stay together; read-only cases get
//     their own chain.
//   - Shapes AND SEQUENCES, but no timing. Every poll is recorded, at the cadence
//     the product polls at, because the wait tool IS a poll loop.
//   - The token is re-read from disk for every chain, so a long run survives a
//     token refresh: top up the file and the run continues.

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import { z } from "zod"
import { parseRecorderEnv } from "@/env"
import {
	BoardGuardViolation,
	createBoardGuard,
	ORG_URL,
	SCRATCH_BUCKET_ID,
	SCRATCH_LABEL_ID,
	SCRATCH_PROJECT_ID,
	SCRATCH_PROJECT_NAME,
	SCRATCH_PROJECT_TEAM_MEMBER_ID,
} from "@/lib/cassette/approved-board"
import {
	authOf,
	cassetteSchema,
	collisions,
	duplicateScenarios,
	executingProgressions,
	GUID_SOURCE,
	httpMethodSchema,
	type Interaction,
	interactionSchema,
	jsonObjectSchema,
	jsonValueSchema,
	leaks,
	requiredOperationSetIdSchema,
} from "@/lib/cassette/interaction"
import {
	MAX_WAIT_SECONDS,
	submitOperationSet,
	waitForOperationSet,
} from "@/lib/operation-set"
import {
	createScheduleApiClient,
	type ScheduleApiClient,
	ScheduleApiError,
	type StagedWrite,
} from "@/lib/schedule-api"

const TOKEN_FILE = parseRecorderEnv().CTX_DATAVERSE_TOKEN_FILE
// Kept outside this live recorder so the guard can be tested without importing code
// that contacts the customer organisation.
const boardGuard = createBoardGuard()

const OUT = fileURLToPath(new URL("../__goldens__/", import.meta.url))
const ZERO = "00000000-0000-0000-0000-000000000000"
// Well-formed GUIDs that name no record, distinct from the invalid zero GUID.
const UNKNOWN_BUCKET = "2b8c6d41-5e97-4a03-9f26-8d31c7b45e0a"
const UNKNOWN_TASK = "e40a92f7-13bd-4c58-8e71-6a2f95d0c3b8"
const UNKNOWN_PROJECT = "c17e58d3-6b24-4f90-a852-3d9e0147fa6c"

// Dates carry a time of day ON PURPOSE. A bare `2026-09-07` parses as midnight and
// the scheduler snaps it back to the previous working day's close. The cassette should
// show the unambiguous shape callers must send.
const START = "2026-09-07T09:00:00Z"
const FINISH = "2026-09-11T17:00:00Z"
const LATER_START = "2026-09-21T09:00:00Z"
const LATER_FINISH = "2026-09-25T17:00:00Z"

// The two date shapes the service takes and then silently changes. Named constants so
// the chains that send them read as deliberate rather than as a typo to be tidied up.
// A BARE date carries no time of day and lands on the previous working day's close; an
// INVERTED range finishes before it starts and is recomputed from the duration.
const BARE_DATE = "2026-09-07"
const INVERTED_START = "2026-10-12T09:00:00Z"
const INVERTED_FINISH = "2026-10-02T17:00:00Z"

// One more than the service's per-set ceiling; staging it returns ScheduleAPI-OV-0003.
const OVER_THE_CEILING = 201

// ------------------------------------------------------------- normalization
const recordedResponseSchema = z
	.object({
		_msdyn_psserrorlog_value: z.string().nullish(),
		OperationSetId: z.string().optional(),
	})
	.catchall(jsonValueSchema)

function parseJson<Schema extends z.ZodType>(
	raw: string,
	schema: Schema,
	context: string,
): z.output<Schema> {
	try {
		return schema.parse(JSON.parse(raw))
	} catch (error) {
		throw new Error(`${context} was not valid JSON of the expected shape`, {
			cause: error,
		})
	}
}

type JsonValue = z.output<typeof jsonValueSchema>

const placeholders = new Map<string, string>()
let anonymous = 0
/**
 * Give an id a placeholder name, AND register it as one this run may send.
 *
 * The two are one act on purpose. "This run knows about this id" and "this run is
 * allowed to name it" are the same fact, and keeping them as two lists is how a guard
 * drifts out of step with the thing it guards. Note the asymmetry with the automatic
 * naming inside `normalize`, which writes to `placeholders` DIRECTLY and therefore
 * registers no ownership: those are ids seen in responses, and being told about a record is
 * not permission to write to it.
 */
function registerNamedId(id: string, placeholderName: string): string {
	placeholders.set(id.toLowerCase(), `{{${placeholderName}}}`)
	boardGuard.registerOwnedId(id)
	return id
}
const hasPlaceholder = (id: string): boolean => placeholders.has(id.toLowerCase())
// Built from the shared source so the rewriter and the gate that catches what it missed
// cannot disagree about what a GUID is.
const GUID = new RegExp(GUID_SOURCE, "g")
function normalize(text: string): string {
	return text
		.replaceAll(ORG_URL, "{{org}}")
		.replace(GUID, (guid) => {
			const known = placeholders.get(guid.toLowerCase())
			if (known) return known
			anonymous += 1
			const generated = `{{guid${anonymous}}}`
			placeholders.set(guid.toLowerCase(), generated)
			return generated
		})
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "{{timestamp}}")
}
function normalized(value: JsonValue): JsonValue {
	return parseJson(
		normalize(JSON.stringify(value)),
		jsonValueSchema,
		"normalized interaction data",
	)
}

/**
 * Response metadata this recording deliberately does NOT keep.
 *
 * `@odata.etag` is a Dataverse row version. Nothing in this package reads one,
 * nothing sends `If-Match`, and we make no claim about the concurrency mechanism it
 * belongs to. Keeping it would put a value in the fixture that invites exactly the
 * design nobody has decided to have — and, being volatile, it would first have to be
 * normalized into a placeholder that then means nothing on its own.
 */
function stripUnmodelled(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(stripUnmodelled)
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "@odata.etag")
				.map(([key, nested]) => [key, stripUnmodelled(nested)]),
		)
	}
	return value
}

// ----------------------------------------------------------------- the guard
//
// NOTHING LEAVES THIS PROCESS NAMING A RECORD THIS RUN DOES NOT OWN.
//
// The rule is an ALLOWLIST, not a blocklist, and that direction is the whole point:
// a blocklist protects against the boards someone thought of, and the accident that
// matters is always the one nobody thought of. Every GUID in an outbound request —
// in the body AND in the URL path, because a read names its record in the path — must
// have been registered by this run. Three things register one:
//
//   `boardGuard.registerOwnedId`  a pre-existing record listed once at startup
//   `registerNamedId`             an id given a placeholder for the fixture
//   `mint`                        an id this run generates, with or without a placeholder
//
// plus the ids the SERVICE mints and hands back — operation sets and error logs —
// which are registered as owned when they arrive, because a later call in the same
// chain has to name them.
//
// A violation is not evidence and must never be treated as such. The two drivers that
// accept rejections catch only `ScheduleApiError`, so a local guard failure remains
// loud instead of becoming a log line in a run that keeps going.
//
// The check sits on the ONE choke point every request passes, including the sweep and
// the unrecorded peeks. There is deliberately no way to reach the network from this
// file without going through it.

/**
 * The only fetch in this file that reaches the network, and it cannot be reached
 * without the guard. `rawFetch` is captured once and referenced nowhere else, so
 * there is no unchecked path to the organisation anywhere in this script.
 */
const rawFetch = globalThis.fetch
const guardedFetch: typeof fetch = (input, init) => {
	const url = typeof input === "string" ? input : input.toString()
	const body = typeof init?.body === "string" ? init.body : undefined
	boardGuard.assertRequestWithinApprovedBoard(
		(init?.method ?? "GET").toUpperCase(),
		url,
		body,
	)
	return rawFetch(input, init)
}

// ------------------------------------------------------------------ recording
const interactions: Interaction[] = []
/**
 * Whether traffic is being written into the fixture right now.
 *
 * False for probes and for the sweep — traffic that must still be GUARDED, still
 * register the ids the service mints, and still be held against the open-set ledger,
 * but that no test will ever replay. Never a reason to leave the wrapper.
 */
let capturing = true
let chain = "?"
let stepIndex = 0

// Every set this run created that is not yet known to be closed. The quota is per
// USER and counts OPEN sets, so a run that dies partway leaves the recording identity
// poorer by however many it had in flight — and there is no API to go find them
// again. This ledger exists so the cleanup at the bottom can release them.
const openSets = new Set<string>()

function token(): string {
	return readFileSync(TOKEN_FILE, "utf8").trim()
}

/**
 * Every invariant the cassette must hold, checked after EVERY interaction rather
 * than only before the write. A run takes minutes and creates real OperationSets
 * against a customer org; learning at the end that interaction 3 leaked a token
 * wastes the whole run and the quota it spent.
 */
function auditCassette(): void {
	const serialized = JSON.stringify(interactions)

	// The write-time and committed-bytes gates must reject the same leaks; otherwise a
	// recording can finish successfully and fail only after the fixture is written.
	const leaked = leaks(serialized)
	if (leaked.length > 0) {
		throw new Error(`${leaked.join("; ")} reached the cassette`)
	}

	// ORPHANED PLACEHOLDERS. `registerNamedId()` overwrites whatever `normalize()` already
	// assigned, so an id named AFTER its first sighting is written under a positional
	// placeholder there and its semantic one everywhere after — the same value under
	// two names, invisible in the fixture and fatal to a replay that follows an id out
	// of one recorded body into the next recorded path.
	const live = new Set<string>([...placeholders.values(), "{{org}}", "{{timestamp}}"])
	const orphaned = [...new Set(serialized.match(/\{\{[a-zA-Z0-9_]+\}\}/g) ?? [])].filter(
		(placeholder) => !live.has(placeholder),
	)
	if (orphaned.length > 0) {
		throw new Error(
			`${orphaned.length} orphaned placeholders (${orphaned.join(", ")}) — an id reached the cassette before it was named. Mint and name ids BEFORE the call that sends them.`,
		)
	}

	// The same defect mirrored: TWO distinct ids wearing ONE placeholder.
	const byPlaceholder = new Map<string, number>()
	for (const placeholder of placeholders.values()) {
		byPlaceholder.set(placeholder, (byPlaceholder.get(placeholder) ?? 0) + 1)
	}
	const collided = [...byPlaceholder].filter(([, count]) => count > 1)
	if (collided.length > 0) {
		throw new Error(
			`${collided.length} placeholders naming more than one id: ${collided
				.map(([placeholder, count]) => `${placeholder} → ${count} ids`)
				.join(", ")}`,
		)
	}

	// TWO QUESTIONS ON ONE ROUTING KEY. The replay serves a key's responses in
	// recorded order, so several responses on one key must be the SAME request asked
	// at different moments — a sequence. Two different requests sharing a key mean
	// every one after the first is permanently unreachable.
	const collidedKeys = collisions(interactions)
	if (collidedKeys.length > 0) {
		throw new Error(
			`${collidedKeys
				.map(
					(c) =>
						`routing key ${c.key} answers ${c.requests} different requests (${c.scenarios.map((s) => `"${s}"`).join(", ")})`,
				)
				.join(
					"; ",
				)} — the later ones are unreachable; give each submission its own chain`,
		)
	}

	// Scenario names are documentation, not the replay's routing key — but a name that
	// does not identify what it labels is documentation that lies.
	const duplicated = duplicateScenarios(interactions)
	if (duplicated.length > 0) {
		throw new Error(
			`${duplicated.length} scenario names used more than once: ${duplicated
				.map(([scenario, count]) => `"${scenario}" ×${count}`)
				.join(", ")}`,
		)
	}
}

/**
 * The recording seam: a `fetch` that captures what the CLIENT sends and what the org
 * answers, then hands the response back untouched.
 *
 * Installed once, globally, by this script. The client is unaware of it — which is
 * the point: nothing in the production path exists for the recorder's benefit.
 *
 * Ids are named from the response BEFORE it is normalized. An id is first seen in
 * the response that mints it, so naming it afterwards leaves that first sighting
 * under a positional placeholder and every later sighting under the semantic one.
 */
let mintedOperationSetCount = 0
let mintedErrorLogCount = 0
type LastMintedOperationSet =
	| { state: "not-minted" }
	| { state: "minted"; OperationSetId: string }
let lastMintedOperationSet: LastMintedOperationSet = { state: "not-minted" }
const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString()
	const response = await guardedFetch(input, init)

	const path = url.replace(`${ORG_URL}/api/data/v9.2/`, "")
	const method = httpMethodSchema.parse((init?.method ?? "GET").toUpperCase())
	const requestBody =
		typeof init?.body === "string"
			? parseJson(init.body, jsonObjectSchema, `request body for ${method} ${path}`)
			: undefined
	// Shared with the replay, which has to classify the same header the same way or the
	// routing key it builds will not match the one recorded here.
	const auth = authOf(new Headers(init?.headers).get("authorization") ?? undefined)

	const raw = await response.clone().text()
	const responseBody =
		raw === ""
			? undefined
			: parseJson(raw, recordedResponseSchema, `response to ${method} ${path}`)
	if (responseBody !== undefined) {
		// The two ids the org mints that this recording has to follow: a set id, which
		// every later call in the chain names, and the error log a failed set links.
		// Each gets its own counter, and each is named only on FIRST sighting — a set
		// read twice must not mint a second name for the log it already had.
		if (
			responseBody.OperationSetId !== undefined &&
			!hasPlaceholder(responseBody.OperationSetId)
		) {
			mintedOperationSetCount += 1
			registerNamedId(
				responseBody.OperationSetId,
				`operationSet${mintedOperationSetCount}`,
			)
			openSets.add(responseBody.OperationSetId)
			// Keep the id from the create response even when submission later throws before
			// the caller receives a receipt.
			lastMintedOperationSet = {
				OperationSetId: responseBody.OperationSetId,
				state: "minted",
			}
		}
		if (
			responseBody._msdyn_psserrorlog_value !== undefined &&
			responseBody._msdyn_psserrorlog_value !== null &&
			!hasPlaceholder(responseBody._msdyn_psserrorlog_value)
		) {
			mintedErrorLogCount += 1
			registerNamedId(
				responseBody._msdyn_psserrorlog_value,
				`errorLog${mintedErrorLogCount}`,
			)
		}
	}

	// A SET LEAVES THE LEDGER WHEN IT STOPS BEING OPEN, and exactly two answers do that:
	// an accepted abandon, and an accepted EXECUTE — after which a set is executing, then
	// terminal, and never open again. Read off the REQUEST because that is the only place
	// the id appears.
	//
	// A REFUSED execute deliberately does not remove, and that is the whole reason the
	// ledger exists: an empty set is rejected at execute AND LEFT OPEN, the one failure
	// that strands a quota slot with no API to find it again.
	//
	if (
		(path === "msdyn_AbandonOperationSetV1" || path === "msdyn_ExecuteOperationSetV1") &&
		response.ok
	) {
		const { OperationSetId: closed } = requiredOperationSetIdSchema.parse(requestBody)
		openSets.delete(closed)
	}

	// Capture is optional; guard enforcement, service-minted id registration, and the
	// open-set ledger apply to every request, including probes and cleanup.
	if (capturing) {
		stepIndex += 1
		interactions.push(
			interactionSchema.parse({
				chain,
				request: {
					auth,
					method,
					path: normalize(path),
					...(requestBody === undefined ? {} : { body: normalized(requestBody) }),
				},
				response: {
					...(responseBody === undefined
						? {}
						: { body: stripUnmodelled(normalized(responseBody)) }),
					status: response.status,
					statusText: response.statusText,
				},
				scenario: `${chain} · ${stepIndex}: ${method} ${normalize(path).slice(0, 72)}`,
			}),
		)
		auditCassette()
	}
	console.log(`    ${String(response.status).padEnd(3)} ${method} ${path.slice(0, 76)}`)
	return response
}) as typeof fetch
globalThis.fetch = recordingFetch

// ------------------------------------------------------------------ driving

function api(accessToken = token()): ScheduleApiClient {
	return createScheduleApiClient({ accessToken, orgUrl: ORG_URL })
}

/**
 * Mint an id this run owns, registered before anything can send it.
 *
 * THE ONLY WAY TO MAKE AN ID HERE. A bare `randomUUID()` is unregistered, and the guard
 * refuses it — which is the intended way to notice that a record was created without
 * anyone claiming it.
 *
 * The optional placeholder name is for the fixture. Pass one when a later chain or test
 * refers to the record; otherwise normalization may assign a positional placeholder.
 */
function mint(placeholderName?: string): string {
	const id = randomUUID()
	return placeholderName === undefined
		? boardGuard.registerOwnedId(id)
		: registerNamedId(id, placeholderName)
}

/**
 * Read a record back — DELIBERATELY OUTSIDE THE RECORDING, through `guardedFetch`.
 *
 * Unrecorded is not unguarded: this still cannot name a record outside the approved
 * board. Skipping the recorder is about what belongs in the fixture; the allowlist is
 * about what is allowed to leave the process, and nothing is exempt from that.
 *
 * Some of what this API does is invisible to the traffic production emits. A bare
 * date is ACCEPTED and lands on the previous working day; an inverted range is ACCEPTED and the finish
 * is recomputed. Both settle `completed`, so a chain that sends one records a set that
 * worked and says nothing about the value that was actually stored.
 *
 * The write tools do not read task fields back. Recording that peek would put a
 * request in the fixture that those tools cannot reach.
 *
 * The chain records what production sends; this prints what the board actually holds
 * into the run's output without adding unreachable traffic to the cassette.
 */
async function peekRecord<Schema extends z.ZodType>(
	entitySet: string,
	id: string,
	columns: string,
	schema: Schema,
): Promise<z.output<Schema>> {
	const response = await guardedFetch(
		`${ORG_URL}/api/data/v9.2/${entitySet}(${id})?$select=${columns}`,
		{ headers: { accept: "application/json", authorization: `Bearer ${token()}` } },
	)
	const raw = await response.text()
	if (!response.ok) {
		throw new Error(
			`Recorder read ${entitySet}(${id}) failed: ${response.status} ${response.statusText}${
				raw ? ` — ${raw}` : ""
			}`,
		)
	}
	return parseJson(raw, schema, `response reading ${entitySet}(${id})`)
}

/**
 * Rows matching a filter — the ONLY query in this file that asks the board what it
 * holds rather than telling it. Used by the stray sweep and by nothing else, for the
 * reason written there. Guarded like every other request, and never captured.
 */
async function peekList<Schema extends z.ZodType>(
	entitySet: string,
	filter: string,
	select: string,
	rowSchema: Schema,
): Promise<z.output<Schema>[]> {
	const query = new URLSearchParams({ $filter: filter, $select: select })
	const response = await guardedFetch(
		`${ORG_URL}/api/data/v9.2/${entitySet}?${query.toString()}`,
		{ headers: { accept: "application/json", authorization: `Bearer ${token()}` } },
	)
	const raw = await response.text()
	if (!response.ok) {
		throw new Error(
			`Recorder list ${entitySet} failed: ${response.status} ${response.statusText}${
				raw ? ` — ${raw}` : ""
			}`,
		)
	}
	return parseJson(
		raw,
		z.object({ value: z.array(rowSchema) }),
		`response listing ${entitySet}`,
	).value
}

/**
 * What the board holds for these columns, as one line of the run's own output.
 *
 * The same column list drives the read and rendering so the output cannot report a
 * column that was never requested.
 */
async function peek(entitySet: string, id: string, columns: string): Promise<string> {
	const row = await peekRecord(entitySet, id, columns, jsonObjectSchema)
	return columns
		.split(",")
		.map((column) => `${column}=${JSON.stringify(row[column] ?? null)}`)
		.join(" ")
}

/**
 * Prove the guard is actually ON THE WIRE, before anything else happens.
 *
 * Unit tests prove the check refuses unsafe requests, but cannot prove the production
 * client still routes through it. A tested guard that is bypassed looks healthy.
 *
 * So the run refuses one request on purpose and insists on being refused. The bait is
 * a random id that names NOTHING: if the guard is somehow absent, the worst that
 * escapes is a read of a record that does not exist, on the approved board, which
 * answers 404 and changes not a byte. A live-fire test of a guard must not be able to
 * cause the harm it guards against.
 */
async function assertGuardIsLive(): Promise<void> {
	const unregistered = randomUUID()
	try {
		// Use the same global binding as the production client; calling `guardedFetch`
		// directly would prove the function, not the wiring.
		await fetch(
			`${ORG_URL}/api/data/v9.2/msdyn_projects(${unregistered})?$select=msdyn_subject`,
		)
	} catch (error) {
		if (!(error instanceof BoardGuardViolation)) throw error
		console.log("guard verified: an unregistered id was refused before it was sent")
		return
	}
	throw new BoardGuardViolation(
		"THE GUARD IS NOT ON THE WIRE. A request naming an unregistered id was allowed through, which means this script can currently reach records it does not own. Nothing has been written. Find what bypasses guardedFetch before running again.",
	)
}

/**
 * Prove the board IS the board, before the first write.
 *
 * The allowlist guarantees this run only ever names the GUIDs it was given. It cannot
 * tell you those GUIDs are the right ones — a constant mistyped into naming some other
 * real project would be allowlisted just as faithfully, and the guard would wave every
 * request through while tasks landed on a stranger's board.
 *
 * So the GUID-addressed row is also checked against its live name. The name is used
 * only to refuse a mismatched GUID, never to select a board.
 *
 * Read-only, and it runs before anything is created.
 */
async function assertApprovedBoard(): Promise<void> {
	const { msdyn_subject: subject } = await peekRecord(
		"msdyn_projects",
		SCRATCH_PROJECT_ID,
		"msdyn_subject",
		z.object({ msdyn_subject: z.string() }),
	)
	if (subject !== SCRATCH_PROJECT_NAME) {
		throw new BoardGuardViolation(
			`REFUSED BEFORE ANY WRITE: project ${SCRATCH_PROJECT_ID} is named ${JSON.stringify(subject)}, but this script is only ever allowed to write to ${JSON.stringify(SCRATCH_PROJECT_NAME)}. Either the constant is wrong or the board was renamed. Nothing was written. Do NOT reconcile this by editing the expected name — confirm which board that GUID is first.`,
		)
	}
	console.log(
		`board verified: ${SCRATCH_PROJECT_ID} is ${JSON.stringify(SCRATCH_PROJECT_NAME)}`,
	)
}

async function record(
	chainName: string,
	run: (client: ScheduleApiClient) => Promise<void>,
): Promise<void> {
	chain = chainName
	stepIndex = 0
	lastMintedOperationSet = { state: "not-minted" }
	console.log(`\n${chainName}`)
	await run(api())
}

/** Record a chain whose promised outcome is a synchronous service rejection. */
async function recordRejection(
	chainName: string,
	run: (client: ScheduleApiClient) => Promise<void>,
): Promise<void> {
	await record(chainName, async (client) => {
		try {
			await run(client)
		} catch (error) {
			if (!(error instanceof ScheduleApiError)) throw error
			console.log(
				`    (chain ended on a rejection — recorded) ${String(error).slice(0, 160)}`,
			)
			return
		}
		throw new Error(`Chain '${chainName}' was expected to be rejected, but it succeeded.`)
	})
}

/**
 * Drive the real API and record NOTHING.
 *
 * A chain is traffic PRODUCTION CAN EMIT. Several things worth knowing are things
 * `server.ts` refuses before any HTTP happens — a date with no time of day, a set with
 * nothing in it, an operation count over the ceiling. Recording those would put
 * requests in the fixture that no code can ever reach: the same defect as a colliding
 * routing key, wearing a different hat.
 *
 * They still have to be DRIVEN, because a guard that has never been tested against the
 * real service is a guess about why it exists. They run here and print their outcomes
 * without adding unreachable traffic to the cassette.
 *
 * The recording seam stays installed for guards, id registration, and the open-set
 * ledger, but capture is disabled before any probe traffic occurs.
 */
async function probe(
	what: string,
	run: (client: ScheduleApiClient) => Promise<void>,
): Promise<void> {
	chain = `probe:${what}`
	stepIndex = 0
	lastMintedOperationSet = { state: "not-minted" }
	// Disable capture before the probe because its cleanup can reuse routing keys. All
	// traffic still passes through bookkeeping and guards.
	capturing = false
	console.log(`\nprobe: ${what}`)
	try {
		await run(api())
		console.log("    accepted")
	} catch (error) {
		if (!(error instanceof ScheduleApiError)) throw error
		console.log(`    refused — ${String(error).slice(0, 400)}`)
	} finally {
		capturing = true
	}
}

/** Submit one set, then wait on it — the two calls a caller actually makes. */
async function submitAndWait(
	client: ScheduleApiClient,
	description: string,
	writes: StagedWrite[],
): Promise<string> {
	const { OperationSetId } = await submitOperationSet(client, {
		Description: description,
		ProjectId: SCRATCH_PROJECT_ID,
		writes,
	})
	const outcome = await waitForOperationSet(client, {
		OperationSetId,
		seconds: MAX_WAIT_SECONDS,
	})
	console.log(`    outcome -> ${JSON.stringify(outcome)}`)
	return OperationSetId
}

// Everything this run creates, so the sweep at the end can take it back out. Module
// scope because the sweep runs in `finally`, outside the driving.
// KEYED BY ID, because every use of it is by id. As an array this needed a `forget`
// helper doing `splice(findIndex(...))` and a comment warning that a miss returns -1 and
// splices the LAST element instead — a data structure that could not express "remove
// this one" without a footnote about the wrong record being removed. Insertion order is
// preserved, so the deepest-first sweep still reads `[...litter].reverse()`.
const litter = new Map<string, StagedWrite["entity"]>()

// A task the later chains mutate. Created first so every update chain has a real
// target that this run constructed rather than found.
const SUBJECT = "ZZ cassette task"

async function preflight(): Promise<void> {
	// Naming these is also what ALLOWS them — see `registerNamedId`. Nothing else on
	// the board is registered, so any other record in the organisation is unreachable.
	// The four fictional ids are registered for the same reason the real ones are: the
	// rejection chains send them deliberately, and the guard does not distinguish
	// between an id that names nothing and an id that names somebody's project. Only
	// this list does.
	registerNamedId(SCRATCH_PROJECT_ID, "projectId")
	registerNamedId(SCRATCH_BUCKET_ID, "bucketId")
	registerNamedId(SCRATCH_LABEL_ID, "labelId")
	registerNamedId(SCRATCH_PROJECT_TEAM_MEMBER_ID, "teamMemberId")
	registerNamedId(ZERO, "zeroGuid")
	registerNamedId(UNKNOWN_BUCKET, "unknownBucketId")
	registerNamedId(UNKNOWN_TASK, "unknownTaskId")
	registerNamedId(UNKNOWN_PROJECT, "unknownProjectId")

	// Two proofs before anything is created, in this order: that the guard is on the
	// wire at all, and then that the board it is protecting is the one we think it is.
	// The first has to come first — the second is itself a request through the guard,
	// and a check that runs through a mechanism cannot be what establishes it works.
	await assertGuardIsLive()
	await assertApprovedBoard()
}

async function main(): Promise<void> {
	// ---- the shapes a create can take ---------------------------------------
	const plainTask = mint("plainTaskId")
	await record("create-task", async (client) => {
		await submitAndWait(client, "ContextLayer: create a task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: plainTask,
					msdyn_subject: SUBJECT,
				},
				verb: "create",
			},
		])
		litter.set(plainTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: plainTask,
		})
	})

	const datedTask = mint("datedTaskId")
	await record("create-task-with-dates", async (client) => {
		await submitAndWait(client, "ContextLayer: create a task with dates", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_finish: FINISH,
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: datedTask,
					msdyn_start: START,
					msdyn_subject: "ZZ cassette dated task",
				},
				verb: "create",
			},
		])
		litter.set(datedTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: datedTask,
		})
	})

	const richTask = mint("richTaskId")
	await record("create-task-with-every-field", async (client) => {
		await submitAndWait(client, "ContextLayer: create a fully described task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_description:
						"What the client asked for, and by when.\n\nSecond paragraph.",
					msdyn_finish: FINISH,
					msdyn_outlinelevel: 1,
					msdyn_priority: 7,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: richTask,
					msdyn_start: START,
					msdyn_subject: "ZZ cassette rich task",
				},
				verb: "create",
			},
		])
		litter.set(richTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: richTask,
		})
	})

	const childTask = mint("childTaskId")
	await record("create-subtask", async (client) => {
		await submitAndWait(client, "ContextLayer: create a subtask", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 2,
					"msdyn_parenttask@odata.bind": `/msdyn_projecttasks(${plainTask})`,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: childTask,
					msdyn_subject: "ZZ cassette subtask",
				},
				verb: "create",
			},
		])
		litter.set(childTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: childTask,
		})
	})

	// Use level three to exercise a deeper caller-supplied outline level. This file
	// cannot derive it without a read; a wrong value silently misnests the task.
	const grandchildTask = mint("grandchildTaskId")
	await record("create-deep-subtask", async (client) => {
		await submitAndWait(client, "ContextLayer: create a subtask of a subtask", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 3,
					"msdyn_parenttask@odata.bind": `/msdyn_projecttasks(${childTask})`,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: grandchildTask,
					msdyn_subject: "ZZ cassette deep subtask",
				},
				verb: "create",
			},
		])
		litter.set(grandchildTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: grandchildTask,
		})
	})

	// ---- the shapes an update can take --------------------------------------
	await record("update-task-name", async (client) => {
		await submitAndWait(client, "ContextLayer: rename a task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: plainTask,
					msdyn_subject: "ZZ cassette renamed",
				},
				verb: "update",
			},
		])
	})

	await record("update-task-progress", async (client) => {
		await submitAndWait(client, "ContextLayer: mark a task half done", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_progress: 0.5,
					msdyn_projecttaskid: plainTask,
				},
				verb: "update",
			},
		])
	})

	await record("update-task-done", async (client) => {
		await submitAndWait(client, "ContextLayer: mark a task done", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_progress: 1,
					msdyn_projecttaskid: plainTask,
				},
				verb: "update",
			},
		])
	})

	await record("update-task-dates", async (client) => {
		await submitAndWait(client, "ContextLayer: move a task's dates", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_finish: LATER_FINISH,
					msdyn_projecttaskid: datedTask,
					msdyn_start: LATER_START,
				},
				verb: "update",
			},
		])
	})

	await record("update-task-description", async (client) => {
		await submitAndWait(client, "ContextLayer: describe a task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_description: "Revised brief after Tuesday's call.",
					msdyn_projecttaskid: plainTask,
				},
				verb: "update",
			},
		])
	})

	await record("update-task-many-fields", async (client) => {
		await submitAndWait(client, "ContextLayer: rename, re-date and prioritise", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_description: "Everything at once, one transaction.",
					msdyn_finish: LATER_FINISH,
					msdyn_priority: 2,
					msdyn_progress: 0.25,
					msdyn_projecttaskid: richTask,
					msdyn_start: LATER_START,
					msdyn_subject: "ZZ cassette multi-field update",
				},
				verb: "update",
			},
		])
	})

	// ---- buckets ------------------------------------------------------------
	const newBucket = mint("newBucketId")
	await record("create-bucket", async (client) => {
		await submitAndWait(client, "ContextLayer: create a bucket", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Bucket",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectbucketid: newBucket,
				},
				verb: "create",
			},
		])
		litter.set(newBucket, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
			msdyn_projectbucketid: newBucket,
		})
	})

	await record("update-bucket-name", async (client) => {
		await submitAndWait(client, "ContextLayer: rename a bucket", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Bucket Renamed",
					msdyn_projectbucketid: newBucket,
				},
				verb: "update",
			},
		])
	})

	await record("move-task-between-buckets", async (client) => {
		await submitAndWait(client, "ContextLayer: move a task to another bucket", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${newBucket})`,
					msdyn_projecttaskid: datedTask,
				},
				verb: "update",
			},
		])
	})

	// THE FLOW THIS WHOLE SHAPE EXISTS FOR: a bucket that does not exist yet, and the
	// tasks going into it, as ONE transaction and ONE approval. The tasks reference a
	// bucket created in the same collection — possible only because the ids are ours.
	const freshBucket = mint("freshBucketId")
	const freshTaskA = mint("freshTaskAId")
	const freshTaskB = mint("freshTaskBId")
	await record("create-bucket-with-its-tasks", async (client) => {
		await submitAndWait(client, "ContextLayer: new bucket and its first tasks", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Same-Set Bucket",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectbucketid: freshBucket,
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${freshBucket})`,
					msdyn_projecttaskid: freshTaskA,
					msdyn_subject: "ZZ cassette same-set task A",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${freshBucket})`,
					msdyn_projecttaskid: freshTaskB,
					msdyn_subject: "ZZ cassette same-set task B",
				},
				verb: "create",
			},
		])
		litter.set(freshTaskA, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: freshTaskA,
		})
		litter.set(freshTaskB, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: freshTaskB,
		})
		litter.set(freshBucket, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
			msdyn_projectbucketid: freshBucket,
		})
	})

	// ---- labels -------------------------------------------------------------
	await record("rename-label", async (client) => {
		await submitAndWait(client, "ContextLayer: name a label", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectlabel",
					msdyn_projectlabelid: SCRATCH_LABEL_ID,
					msdyn_projectlabeltext: "ZZ Cassette Label",
				},
				verb: "update",
			},
		])
	})

	const labelLink = mint("labelLinkId")
	await record("attach-label", async (client) => {
		await submitAndWait(client, "ContextLayer: put a label on a task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
					"msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${SCRATCH_LABEL_ID})`,
					"msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${plainTask})`,
					msdyn_projecttasktolabelid: labelLink,
				},
				verb: "create",
			},
		])
		litter.set(labelLink, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
			msdyn_projecttasktolabelid: labelLink,
		})
	})

	await record("detach-label", async (client) => {
		await submitAndWait(client, "ContextLayer: take a label off a task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
					msdyn_projecttasktolabelid: labelLink,
				},
				verb: "delete",
			},
		])
		litter.delete(labelLink)
	})

	// ---- people -------------------------------------------------------------
	// A task of its OWN, with no children: a parent cannot be assigned to, and
	// `create-subtask` has already made `plainTask` one.
	const assignableTask = mint("assignableTaskId")
	const assignment = mint("assignmentId")
	await record("assign-task", async (client) => {
		await submitAndWait(client, "ContextLayer: a task, then assign it", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: assignableTask,
					msdyn_subject: "ZZ cassette assignable task",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
					msdyn_name: "ZZ cassette assignment",
					"msdyn_projectid@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${SCRATCH_PROJECT_TEAM_MEMBER_ID})`,
					msdyn_resourceassignmentid: assignment,
					"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${assignableTask})`,
				},
				verb: "create",
			},
		])
		litter.set(assignableTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: assignableTask,
		})
		litter.set(assignment, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
			msdyn_resourceassignmentid: assignment,
		})
	})

	// A SUMMARY task refuses assignment, and says so in its own words. Worth its own
	// chain because nothing about the entity shape hints at it: the same request that
	// succeeds above fails here purely because this task has a child.
	await recordRejection("reject-assign-to-a-parent-task", async (client) => {
		await submitAndWait(client, "ContextLayer: assign a task that has subtasks", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
					msdyn_name: "ZZ cassette parent assignment",
					"msdyn_projectid@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${SCRATCH_PROJECT_TEAM_MEMBER_ID})`,
					msdyn_resourceassignmentid: mint("parentAssignmentId"),
					"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${plainTask})`,
				},
				verb: "create",
			},
		])
	})

	await record("unassign-task", async (client) => {
		await submitAndWait(client, "ContextLayer: take a task off a team member", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
					msdyn_resourceassignmentid: assignment,
				},
				verb: "delete",
			},
		])
		litter.delete(assignment)
	})

	// ---- same-set references --------------------------------------------------
	// Exercise every same-submission reference edge promised by `server.ts`, including
	// references across verb collections. These chains keep that shared namespace
	// replayable as a regression contract.

	const sameSetParent = mint("sameSetParentId")
	const sameSetChild = mint("sameSetChildId")
	await record("create-a-subtask-of-a-same-set-parent", async (client) => {
		await submitAndWait(client, "ContextLayer: a task and its subtask together", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: sameSetParent,
					msdyn_subject: "ZZ cassette same-set parent",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 2,
					"msdyn_parenttask@odata.bind": `/msdyn_projecttasks(${sameSetParent})`,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: sameSetChild,
					msdyn_subject: "ZZ cassette same-set child",
				},
				verb: "create",
			},
		])
		litter.set(sameSetParent, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: sameSetParent,
		})
		litter.set(sameSetChild, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: sameSetChild,
		})
	})

	const labelledTask = mint("labelledTaskId")
	const sameSetLabelLink = mint("sameSetLabelLinkId")
	await record("label-a-task-created-in-the-same-set", async (client) => {
		await submitAndWait(client, "ContextLayer: a task, labelled as it is made", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: labelledTask,
					msdyn_subject: "ZZ cassette labelled-at-birth task",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
					"msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${SCRATCH_LABEL_ID})`,
					"msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${labelledTask})`,
					msdyn_projecttasktolabelid: sameSetLabelLink,
				},
				verb: "create",
			},
		])
		litter.set(labelledTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: labelledTask,
		})
		litter.set(sameSetLabelLink, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
			msdyn_projecttasktolabelid: sameSetLabelLink,
		})
	})

	const createdThenUpdated = mint("createdThenUpdatedId")
	await record("update-a-task-created-in-the-same-set", async (client) => {
		await submitAndWait(client, "ContextLayer: create a task and amend it at once", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: createdThenUpdated,
					msdyn_subject: "ZZ cassette created-then-updated",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_progress: 0.5,
					msdyn_projecttaskid: createdThenUpdated,
					msdyn_subject: "ZZ cassette created-then-updated (amended)",
				},
				verb: "update",
			},
		])
		litter.set(createdThenUpdated, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: createdThenUpdated,
		})
	})

	const sameSetTargetBucket = mint("sameSetTargetBucketId")
	await record("move-a-task-into-a-same-set-bucket", async (client) => {
		await submitAndWait(client, "ContextLayer: a new bucket, and an old task into it", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Destination Bucket",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectbucketid: sameSetTargetBucket,
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${sameSetTargetBucket})`,
					msdyn_projecttaskid: datedTask,
				},
				verb: "update",
			},
		])
		litter.set(sameSetTargetBucket, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
			msdyn_projectbucketid: sameSetTargetBucket,
		})
	})

	// Redundant as user intent, but the schema permits this cross-collection reference,
	// so the recording must keep it reachable.
	const bornThenRenamed = mint("bornThenRenamedBucketId")
	await record("rename-a-bucket-created-in-the-same-set", async (client) => {
		await submitAndWait(client, "ContextLayer: a bucket named twice in one set", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Born Named",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectbucketid: bornThenRenamed,
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Renamed Same Set",
					msdyn_projectbucketid: bornThenRenamed,
				},
				verb: "update",
			},
		])
		litter.set(bornThenRenamed, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
			msdyn_projectbucketid: bornThenRenamed,
		})
	})

	const sameSetNewParent = mint("sameSetNewParentId")
	await record("reparent-a-task-under-a-same-set-task", async (client) => {
		await submitAndWait(client, "ContextLayer: a new parent for an existing task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: sameSetNewParent,
					msdyn_subject: "ZZ cassette adopting parent",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					"msdyn_parenttask@odata.bind": `/msdyn_projecttasks(${sameSetNewParent})`,
					msdyn_projecttaskid: assignableTask,
				},
				verb: "update",
			},
		])
		litter.set(sameSetNewParent, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: sameSetNewParent,
		})
	})

	// ---- order inside a collection ------------------------------------------
	// Reverse the natural dependency order to establish whether `writesOf` needs a
	// topological sort rather than burdening callers with JSON ordering.

	const beforeBucket = mint("beforeBucketId")
	const beforeTaskA = mint("beforeTaskAId")
	const beforeTaskB = mint("beforeTaskBId")
	await record("create-tasks-before-the-bucket-they-name", async (client) => {
		await submitAndWait(client, "ContextLayer: tasks listed ahead of their bucket", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${beforeBucket})`,
					msdyn_projecttaskid: beforeTaskA,
					msdyn_subject: "ZZ cassette out-of-order task A",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${beforeBucket})`,
					msdyn_projecttaskid: beforeTaskB,
					msdyn_subject: "ZZ cassette out-of-order task B",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_name: "ZZ Cassette Out-Of-Order Bucket",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectbucketid: beforeBucket,
				},
				verb: "create",
			},
		])
		litter.set(beforeTaskA, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: beforeTaskA,
		})
		litter.set(beforeTaskB, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: beforeTaskB,
		})
		litter.set(beforeBucket, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
			msdyn_projectbucketid: beforeBucket,
		})
	})

	// This companion case does not prove order independence: the set is refused while
	// reporting its own failure, so the underlying reason stays unknown. It is a
	// `recordRejection` because being refused IS its outcome — driven through plain
	// `record`, the refusal propagates and takes the whole run down before the cassette
	// is written, which is how the first re-record after the checks died.
	const orderedTask = mint("orderedTaskId")
	const orderedAssignment = mint("orderedAssignmentId")
	await recordRejection("create-an-assignment-before-its-task", async (client) => {
		await submitAndWait(client, "ContextLayer: an assignment listed ahead of its task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
					msdyn_name: "ZZ cassette out-of-order assignment",
					"msdyn_projectid@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectteamid@odata.bind": `/msdyn_projectteams(${SCRATCH_PROJECT_TEAM_MEMBER_ID})`,
					msdyn_resourceassignmentid: orderedAssignment,
					"msdyn_taskid@odata.bind": `/msdyn_projecttasks(${orderedTask})`,
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: orderedTask,
					msdyn_subject: "ZZ cassette out-of-order assigned task",
				},
				verb: "create",
			},
		])
		litter.set(orderedTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: orderedTask,
		})
		litter.set(orderedAssignment, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
			msdyn_resourceassignmentid: orderedAssignment,
		})
	})

	// ---- advertised field coverage -------------------------------------------

	// Working days, and the schedule's own arithmetic: writing a duration MOVES THE
	// FINISH. The peek is what shows it — the set only ever says `completed`.
	await record("update-task-duration", async (client) => {
		await submitAndWait(client, "ContextLayer: set a task's duration", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_duration: 3,
					msdyn_projecttaskid: datedTask,
				},
				verb: "update",
			},
		])
		console.log(
			`    read back: ${await peek("msdyn_projecttasks", datedTask, "msdyn_start,msdyn_finish,msdyn_duration")}`,
		)
	})

	await record("update-task-effort", async (client) => {
		await submitAndWait(client, "ContextLayer: set a task's effort", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_effort: 12,
					msdyn_projecttaskid: richTask,
				},
				verb: "update",
			},
		])
	})

	// Accepted boundaries matter as much as refusals: they distinguish a matching
	// schema from one that is merely narrower than the service.
	await record("update-task-lowest-priority-and-no-progress", async (client) => {
		await submitAndWait(client, "ContextLayer: lowest priority, nothing done", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_priority: 0,
					msdyn_progress: 0,
					msdyn_projecttaskid: datedTask,
				},
				verb: "update",
			},
		])
	})

	await record("update-task-highest-priority", async (client) => {
		await submitAndWait(client, "ContextLayer: the highest priority the service takes", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_priority: 10,
					msdyn_projecttaskid: richTask,
				},
				verb: "update",
			},
		])
	})

	// ---- many operations, and many verbs, in one set -------------------------
	const batch = [
		mint("batchTaskAId"),
		mint("batchTaskBId"),
		mint("batchTaskCId"),
	] as const
	await record("create-many-tasks", async (client) => {
		await submitAndWait(
			client,
			"ContextLayer: create three tasks at once",
			batch.map((taskId, at) => ({
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: taskId,
					msdyn_subject: `ZZ cassette batch ${at + 1}`,
				},
				verb: "create",
			})),
		)
		for (const id of batch)
			litter.set(id, {
				"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
				msdyn_projecttaskid: id,
			})
	})

	const mixedNew = mint("mixedNewTaskId")
	await record("create-update-and-delete-together", async (client) => {
		await submitAndWait(client, "ContextLayer: one transaction, three verbs", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: mixedNew,
					msdyn_subject: "ZZ cassette mixed create",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: richTask,
					msdyn_subject: "ZZ cassette mixed update",
				},
				verb: "update",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: batch[2],
				},
				verb: "delete",
			},
		])
		litter.set(mixedNew, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: mixedNew,
		})
		litter.delete(batch[2])
	})

	// ---- deletes ------------------------------------------------------------
	await record("delete-task", async (client) => {
		await submitAndWait(client, "ContextLayer: delete a task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: batch[1],
				},
				verb: "delete",
			},
		])
		litter.delete(batch[1])
	})

	// A bucket delete takes its tasks with it. Recorded as its own chain because the
	// set reports nothing but `completed` — the cascade is invisible on the wire, and
	// this is the only place it is written down as observed rather than believed.
	await record("delete-bucket-and-its-tasks", async (client) => {
		await submitAndWait(client, "ContextLayer: delete a bucket", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_projectbucketid: freshBucket,
				},
				verb: "delete",
			},
		])
		// The bucket's tasks go with it — that cascade is why they are forgotten here
		// rather than deleted again by cleanup, where they would answer NOT FOUND.
		litter.delete(freshBucket)
		litter.delete(freshTaskA)
		litter.delete(freshTaskB)
	})

	// ---- a set that can never settle ----------------------------------------
	// The execute is refused 403 because the RECORDING IDENTITY cannot create the
	// service's own error-log row (`prvCreatemsdyn_psserrorlog`). With nowhere to
	// write why it failed, the set never reaches `failed`: it sits at `executing`
	// indefinitely, and abandon refuses it because abandon is only valid while a set
	// is OPEN. So this chain records the wedge, and the wait tool answering
	// `executing` truthfully rather than timing out.
	//
	// COVERAGE GAP THIS LEAVES: `waitForOperationSet`'s `failed` branch, which reads
	// the linked error log, is therefore NOT exercised by this cassette. Granting the
	// privilege to the recording identity and re-running would close the gap.
	await record("execute-refused-and-set-wedged-executing", async (client) => {
		try {
			await submitOperationSet(client, {
				Description: "ContextLayer: a value the service rejects at execute",
				ProjectId: SCRATCH_PROJECT_ID,
				writes: [
					{
						entity: {
							"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
							msdyn_progress: 100,
							msdyn_projecttaskid: plainTask,
						},
						verb: "update",
					},
				],
			})
		} catch (error) {
			if (!(error instanceof ScheduleApiError)) throw error
			// A refused execute stays in the ledger so cleanup can determine whether the
			// set remains open and reclaimable.
		}
		// A short window on purpose: the point is that it closes on `executing`, and
		// thirteen recorded reads of the same answer would prove nothing the fourth
		// does not.
		if (lastMintedOperationSet.state === "not-minted") {
			throw new Error("The refused submission minted no operation set to inspect.")
		}
		await waitForOperationSet(client, {
			OperationSetId: lastMintedOperationSet.OperationSetId,
			seconds: 12,
		})
	})

	// The edge refuses this before minting a set, so it is evidence for that guard rather
	// than a conversation production can emit.
	await probe("a task priority above 10", async (client) => {
		await submitAndWait(client, "ContextLayer: priority above the maximum", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_priority: 99,
					msdyn_projecttaskid: plainTask,
				},
				verb: "update",
			},
		])
	})

	// ---- the rejections -----------------------------------------------------
	await recordRejection("reject-unknown-bucket", async (client) => {
		const doomed = mint("taskForUnknownBucketId")
		await submitAndWait(client, "ContextLayer: create into a bucket that is not there", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${UNKNOWN_BUCKET})`,
					msdyn_projecttaskid: doomed,
					msdyn_subject: "ZZ cassette unreachable",
				},
				verb: "create",
			},
		])
	})

	await recordRejection("reject-unknown-task", async (client) => {
		await submitAndWait(client, "ContextLayer: update a task that is not there", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: UNKNOWN_TASK,
					msdyn_subject: "ZZ nowhere",
				},
				verb: "update",
			},
		])
	})

	await recordRejection("reject-delete-unknown-task", async (client) => {
		await submitAndWait(client, "ContextLayer: delete a task that is not there", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: UNKNOWN_TASK,
				},
				verb: "delete",
			},
		])
	})

	await recordRejection("reject-unknown-project", async (client) => {
		await submitOperationSet(client, {
			Description: "ContextLayer: a set for a project that is not there",
			ProjectId: UNKNOWN_PROJECT,
			writes: [
				{
					entity: {
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_projecttaskid: plainTask,
						msdyn_subject: "ZZ nowhere",
					},
					verb: "update",
				},
			],
		})
	})

	// The MCP edge decodes the JWT before constructing this client, so this malformed
	// bearer cannot reach Dataverse through the tool surface and does not belong in a
	// replayable chain.
	await probe("a malformed bearer token", async () => {
		const stale = api("not-a-real-token")
		await submitOperationSet(stale, {
			Description: "ContextLayer: a set with a stale credential",
			ProjectId: SCRATCH_PROJECT_ID,
			writes: [
				{
					entity: {
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_projecttaskid: plainTask,
						msdyn_subject: "ZZ nowhere",
					},
					verb: "update",
				},
			],
		})
	})

	// ---- the wait tool's own surface ----------------------------------------
	await recordRejection("wait-on-a-set-that-does-not-exist", async (client) => {
		await waitForOperationSet(client, { OperationSetId: UNKNOWN_TASK, seconds: 0 })
	})

	await record("wait-zero-seconds", async (client) => {
		const glance = mint("glanceTaskId")
		const { OperationSetId } = await submitOperationSet(client, {
			Description: "ContextLayer: a set glanced at rather than waited on",
			ProjectId: SCRATCH_PROJECT_ID,
			writes: [
				{
					entity: {
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
						msdyn_outlinelevel: 1,
						"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
						"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
						msdyn_projecttaskid: glance,
						msdyn_subject: "ZZ cassette glance",
					},
					verb: "create",
				},
			],
		})
		await waitForOperationSet(client, { OperationSetId, seconds: 0 })
		litter.set(glance, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: glance,
		})
	})

	// ---- probes: driven for real, recorded nowhere ---------------------------
	//
	// These probes represent traffic production cannot emit, for the reason documented
	// above each block. They run last so a stranded set cannot consume a quota slot while
	// the replayable chains still need theirs.
	//
	// What each one is for: a guard in shipped code is a claim about the service, and
	// until the service has been asked, it is a claim nobody has checked.

	// GUARDED BY the `instant` regex in `server.ts`. The claim: a bare date parses as
	// midnight and the scheduler snaps midnight back to the previous working day's
	// close, so a date-only finish silently lands on the previous working day.
	const bareDateTask = mint("bareDateTaskId")
	await probe("a date with no time of day", async (client) => {
		await submitAndWait(client, "ContextLayer: probe a bare date", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_finish: BARE_DATE,
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: bareDateTask,
					msdyn_subject: "ZZ cassette bare date",
				},
				verb: "create",
			},
		])
		litter.set(bareDateTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: bareDateTask,
		})
		console.log(
			`    sent finish=${BARE_DATE}\n    read back: ${await peek("msdyn_projecttasks", bareDateTask, "msdyn_start,msdyn_finish")}`,
		)
	})

	// GUARDED BY the first `refine` in `server.ts`. The claim this one anchors is the
	// sharpest of the three, because it is the reason the guard sits at the EDGE rather
	// than in `operation-set.ts`: an empty set is refused at execute AND LEFT OPEN — the
	// one execute failure that strands a slot against a ten-per-user quota that no API
	// can enumerate. The release block at the bottom takes this one back.
	await probe("a set with nothing staged", async (client) => {
		await submitOperationSet(client, {
			Description: "ContextLayer: probe an empty set",
			ProjectId: SCRATCH_PROJECT_ID,
			writes: [],
		})
	})

	// Owns the service claim behind the third refinement: an inverted range succeeds
	// but persists different dates. It is a probe because the edge makes this traffic
	// unreachable in production.
	const invertedTask = mint("invertedTaskId")
	await probe("a finish earlier than its start", async (client) => {
		await submitAndWait(client, "ContextLayer: probe an inverted date range", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_finish: INVERTED_FINISH,
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: invertedTask,
					msdyn_start: INVERTED_START,
					msdyn_subject: "ZZ cassette inverted range",
				},
				verb: "create",
			},
		])
		litter.set(invertedTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: invertedTask,
		})
		console.log(
			`    sent start=${INVERTED_START} finish=${INVERTED_FINISH}\n    read back: ${await peek("msdyn_projecttasks", invertedTask, "msdyn_start,msdyn_finish,msdyn_duration")}`,
		)
	})

	// GUARDED BY the second `refine` (`MAX_OPERATIONS`). Deliberately built from DELETES
	// OF IDS THAT DO NOT EXIST: whichever way the service answers, nothing is created
	// and there is nothing to sweep. A refusal that names the count tells us the ceiling
	// binds and roughly where; a refusal that names a missing record tells us the count
	// was not what stopped it.
	await probe(`${OVER_THE_CEILING} operations in one set`, async (client) => {
		await submitOperationSet(client, {
			Description: "ContextLayer: probe the operation ceiling",
			ProjectId: SCRATCH_PROJECT_ID,
			writes: Array.from({ length: OVER_THE_CEILING }, () => ({
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_projecttaskid: mint(),
				},
				verb: "delete",
			})),
		})
	})

	// UNREACHABLE THROUGH THE TOOLS, both of them: a caller never supplies an id for a
	// create — it names the record with a `ref` and `server.ts` mints the id — so
	// neither a duplicate nor a collision with an existing record can be expressed.
	// Driven anyway because both are what a RETRY looks like from the service's side,
	// and nothing in this package yet says what a retried submission does.
	const twiceTask = mint("twiceTaskId")
	await probe("the same record id twice in one set", async (client) => {
		await submitAndWait(client, "ContextLayer: probe a duplicated id", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: twiceTask,
					msdyn_subject: "ZZ cassette twice A",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: twiceTask,
					msdyn_subject: "ZZ cassette twice B",
				},
				verb: "create",
			},
		])
		litter.set(twiceTask, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: twiceTask,
		})
	})

	await probe("a create naming a record that already exists", async (client) => {
		await submitAndWait(client, "ContextLayer: probe re-creating an existing task", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: plainTask,
					msdyn_subject: "ZZ cassette recreated",
				},
				verb: "create",
			},
		])
	})

	// ---- proven but unmodelled tables ----------------------------------------
	// Probe these tables before the tools advertise them; metadata alone is
	// insufficient. The case-sensitive navigation properties intentionally match the
	// organisation metadata even though their casing is inconsistent.

	// ---- deliberately unsupported columns -----------------------------------
	// The tool schemas omit these refused fields, making the traffic unreachable in production.
	// Keep the probes so any service change is observed before the surface changes.

	await probe("a display order on a bucket, on create", async (client) => {
		await submitAndWait(client, "ContextLayer: probe bucket display order (create)", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",

					msdyn_displayorder: 3,
					msdyn_name: "ZZ cassette placed bucket",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectbucketid: mint(),
				},
				verb: "create",
			},
		])
	})

	// Use an existing bucket so any rejection isolates `msdyn_displayorder`.
	await probe("a display order on a bucket, on update", async (client) => {
		await submitAndWait(client, "ContextLayer: probe bucket display order (update)", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
					msdyn_displayorder: 2,
					msdyn_projectbucketid: newBucket,
				},
				verb: "update",
			},
		])
	})

	await probe("a colour on a label", async (client) => {
		await submitAndWait(client, "ContextLayer: probe label colour", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectlabel",
					msdyn_colorindex: 192350007,
					msdyn_projectlabelid: SCRATCH_LABEL_ID,
				},
				verb: "update",
			},
		])
	})

	await probe("a sprint", async (client) => {
		const sprintId = mint()
		await submitAndWait(client, "ContextLayer: probe a sprint", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectsprint",

					msdyn_finish: FINISH,
					msdyn_name: "ZZ cassette sprint",
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_projectsprintid: sprintId,
					msdyn_start: START,
				},
				verb: "create",
			},
		])
		// The sprint probe takes its own litter back out rather than leaving it on the board.
		await submitAndWait(client, "ContextLayer: probe sprint cleanup", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectsprint",
					msdyn_projectsprintid: sprintId,
				},
				verb: "delete",
			},
		])
	})

	await probe("a goal, and a task attached to it", async (client) => {
		const goalId = mint()
		const linkId = mint()
		await submitAndWait(client, "ContextLayer: probe a goal and a task-to-goal link", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectgoal",

					msdyn_colorindex: 192350003,
					msdyn_description: "What this goal is for.",
					// NO `msdyn_displayorder`. It reports writable on this table too and the
					// service refuses it here as well — the same column, the same refusal, on a
					// third table. Sending it failed the whole set and so hid whether anything
					// ELSE about a goal is writable, which is the only question this probe has.
					msdyn_end: FINISH,
					msdyn_name: "ZZ cassette goal",
					// 0 Low, 1 Medium, 2 High. 0 Not Started, 1 On Track, 2 Behind, 3 At Risk,
					// 4 Closed, 5 Postponed, 6 Unknown, 7 Reopened.
					msdyn_priority: 2,
					msdyn_projectgoalid: goalId,
					"msdyn_projectid@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					msdyn_start: START,
					msdyn_status: 1,
				},
				verb: "create",
			},
			// Named in the SAME collection as the goal it points at — the intra-collection
			// reference that `create-bucket-with-its-tasks` already proves works.
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktogoal",
					"msdyn_projectgoalid@odata.bind": `/msdyn_projectgoals(${goalId})`,
					"msdyn_projecttaskid@odata.bind": `/msdyn_projecttasks(${richTask})`,

					msdyn_projecttasktogoalid: linkId,
				},
				verb: "create",
			},
		])
		await submitAndWait(client, "ContextLayer: probe goal-link cleanup", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktogoal",
					msdyn_projecttasktogoalid: linkId,
				},
				verb: "delete",
			},
		])
		await submitAndWait(client, "ContextLayer: probe goal cleanup", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectgoal",
					msdyn_projectgoalid: goalId,
				},
				verb: "delete",
			},
		])
	})

	await probe("a checklist item on a task", async (client) => {
		const checklistId = mint()
		await submitAndWait(client, "ContextLayer: probe a checklist item", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectchecklist",

					msdyn_name: "ZZ cassette checklist item",
					"msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${richTask})`,
					msdyn_projectchecklistcompleted: false,
					msdyn_projectchecklistid: checklistId,
					msdyn_projectchecklistorder: 1,
				},
				verb: "create",
			},
		])
		await submitAndWait(client, "ContextLayer: probe checklist cleanup", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectchecklist",
					msdyn_projectchecklistid: checklistId,
				},
				verb: "delete",
			},
		])
	})

	// A dependency can cascade a predecessor date change to the successor while the set
	// reports only `completed`. Construct both tasks here so the probe cannot affect an
	// earlier chain.
	await probe("a finish-to-start dependency between two tasks", async (client) => {
		const predecessor = mint()
		const successor = mint()
		const dependencyId = mint()
		await submitAndWait(client, "ContextLayer: probe a task dependency", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_finish: FINISH,
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: predecessor,
					msdyn_start: START,
					msdyn_subject: "ZZ cassette predecessor",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_outlinelevel: 1,
					"msdyn_project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,
					"msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${SCRATCH_BUCKET_ID})`,
					msdyn_projecttaskid: successor,
					msdyn_subject: "ZZ cassette successor",
				},
				verb: "create",
			},
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",

					"msdyn_PredecessorTask@odata.bind": `/msdyn_projecttasks(${predecessor})`,
					"msdyn_Project@odata.bind": `/msdyn_projects(${SCRATCH_PROJECT_ID})`,

					msdyn_projecttaskdependencyid: dependencyId,
					// 0 FinishToFinish, 1 FinishToStart, 2 StartToFinish, 3 StartToStart.
					msdyn_projecttaskdependencylinktype: 1,
					"msdyn_SuccessorTask@odata.bind": `/msdyn_projecttasks(${successor})`,
				},
				verb: "create",
			},
		])
		console.log(
			`    successor before: ${await peek("msdyn_projecttasks", successor, "msdyn_start,msdyn_finish")}`,
		)
		// Move the predecessor and watch what happens to a task nobody named.
		await submitAndWait(client, "ContextLayer: probe the dependency cascade", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
					msdyn_finish: LATER_FINISH,
					msdyn_projecttaskid: predecessor,
					msdyn_start: LATER_START,
				},
				verb: "update",
			},
		])
		console.log(
			`    successor after:  ${await peek("msdyn_projecttasks", successor, "msdyn_start,msdyn_finish")}`,
		)
		// The dependency first and alone: a delete collection cannot hold both a
		// container and the records it takes with it.
		await submitAndWait(client, "ContextLayer: probe dependency cleanup", [
			{
				entity: {
					"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
					msdyn_projecttaskdependencyid: dependencyId,
				},
				verb: "delete",
			},
		])
		litter.set(predecessor, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: predecessor,
		})
		litter.set(successor, {
			"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
			msdyn_projecttaskid: successor,
		})
	})
}

/**
 * Put the board back — DELIBERATELY OUTSIDE THE RECORDING.
 *
 * Cleanup stays outside recording because it is not replayable API behaviour. Use
 * one submission per record because a delete collection cannot hold both a container
 * and its contents.
 *
 * One submission per record, each tolerated: by the time the sweep runs, a record
 * may already have gone with its parent or its bucket, and a not-found there is the
 * expected answer rather than a problem.
 */
async function sweep(): Promise<void> {
	// Stops capture only. Cleanup stays inside the wrapper for guard enforcement,
	// service-minted id registration, and open-set bookkeeping.
	capturing = false
	const client = api()
	// Deepest first: a subtask outlives nothing, and removing it before its parent
	// keeps every delete a delete rather than a cascade someone has to reason about.
	//
	// TWO PASSES, because the first may race a record that has not materialised yet.
	// Refusals remain ambiguous; only the fresh query below decides what survived.
	let outstanding = [...litter].reverse().map(([id, entity]) => ({ entity, id }))
	let lastRefusal = ""
	for (const _pass of [1, 2]) {
		const refused: typeof outstanding = []
		for (const { entity, id } of outstanding) {
			try {
				await submitOperationSet(client, {
					Description: "ContextLayer: sweep",
					ProjectId: SCRATCH_PROJECT_ID,
					writes: [{ entity, verb: "delete" }],
				})
			} catch (error) {
				if (!(error instanceof ScheduleApiError)) throw error
				lastRefusal = String(error)
				refused.push({ entity, id })
			}
		}
		outstanding = refused
		if (outstanding.length === 0) break
	}
	// A refusal does not prove survival: a cascade may already have removed the row.
	// `sweepStrays` owns the fresh-read verdict, so this is diagnostic only.
	if (outstanding.length > 0) {
		console.log(
			`  ${outstanding.length} ledger delete(s) refused on both passes (usually a cascade got there first; verified by the stray check below): ${outstanding
				.map((r) => `${r.entity["@odata.type"]} ${r.id}`)
				.join(", ")}\n     last refusal: ${lastRefusal.slice(0, 200)}`,
		)
	}
	// The label cannot be deleted, only put back the way the project was born with it:
	// its text blanked. The label is the ONE record this run changes that it did not
	// create, and the text is now the ONLY thing about it this run can change — the
	// service refuses to let anyone move a label's colour, which is what makes restoring
	// one unnecessary rather than merely unimplemented.
	let labelRestored = true
	try {
		await submitOperationSet(client, {
			Description: "ContextLayer: sweep the label",
			ProjectId: SCRATCH_PROJECT_ID,
			writes: [
				{
					entity: {
						"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectlabel",
						msdyn_projectlabelid: SCRATCH_LABEL_ID,
						msdyn_projectlabeltext: "",
					},
					verb: "update",
				},
			],
		})
	} catch (error) {
		if (!(error instanceof ScheduleApiError)) throw error
		labelRestored = false
		process.exitCode = 1
		console.log(`  !! could not restore the label — ${error.message}`)
	}
	console.log(
		`  swept ${litter.size - outstanding.length} of ${litter.size} record(s); label ${
			labelRestored ? "restored" : "NOT restored"
		}`,
	)
	await sweepStrays(client)
}

/** Everything this run's records are named with. The sweep keys off exactly this. */
const LITTER_PREFIX = "ZZ cassette"

/**
 * Take back anything on the board wearing this run's name, including records left by
 * an interrupted run that the in-process ledger cannot know.
 *
 * Cleanup is the only path that discovers records by query. Before registering a
 * discovered id, it requires both an approved-project filter and `LITTER_PREFIX`.
 */
type Stray = {
	entity: StagedWrite["entity"]
	kind: "bucket" | "goal" | "sprint" | "task"
	label: string
}

/** Everything on the approved board currently wearing this run's name. */
async function strayRecords(): Promise<Stray[]> {
	const strays: Stray[] = []
	for (const [entitySet, projectColumn, select, rowSchema, kind] of [
		[
			"msdyn_projecttasks",
			"_msdyn_project_value",
			"msdyn_projecttaskid,msdyn_subject",
			z.object({ msdyn_projecttaskid: z.string(), msdyn_subject: z.string() }),
			"task",
		],
		[
			"msdyn_projectbuckets",
			"_msdyn_project_value",
			"msdyn_projectbucketid,msdyn_name",
			z.object({ msdyn_name: z.string(), msdyn_projectbucketid: z.string() }),
			"bucket",
		],
		[
			"msdyn_projectsprints",
			"_msdyn_project_value",
			"msdyn_projectsprintid,msdyn_name",
			z.object({ msdyn_name: z.string(), msdyn_projectsprintid: z.string() }),
			"sprint",
		],
		[
			"msdyn_projectgoals",
			"_msdyn_projectid_value",
			"msdyn_projectgoalid,msdyn_name",
			z.object({ msdyn_name: z.string(), msdyn_projectgoalid: z.string() }),
			"goal",
		],
	] as const) {
		const rows = await peekList(
			entitySet,
			`${projectColumn} eq ${SCRATCH_PROJECT_ID}`,
			select,
			rowSchema,
		)
		for (const row of rows) {
			// The prefix test is case-insensitive because buckets are named "ZZ Cassette …"
			// and tasks "ZZ cassette …", and a sweep that missed half of them on a capital
			// letter would be worse than no sweep at all.
			const label = "msdyn_subject" in row ? row.msdyn_subject : row.msdyn_name
			if (!label.toLowerCase().startsWith(LITTER_PREFIX.toLowerCase())) continue
			const id =
				"msdyn_projecttaskid" in row
					? row.msdyn_projecttaskid
					: "msdyn_projectbucketid" in row
						? row.msdyn_projectbucketid
						: "msdyn_projectsprintid" in row
							? row.msdyn_projectsprintid
							: row.msdyn_projectgoalid
			boardGuard.registerOwnedId(id)
			strays.push({
				entity:
					kind === "task"
						? {
								"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
								msdyn_projecttaskid: id,
							}
						: kind === "bucket"
							? {
									"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
									msdyn_projectbucketid: id,
								}
							: kind === "sprint"
								? {
										"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectsprint",
										msdyn_projectsprintid: id,
									}
								: {
										"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectgoal",
										msdyn_projectgoalid: id,
									},
				kind,
				label,
			})
		}
	}
	return strays
}

async function sweepStrays(client: ScheduleApiClient): Promise<void> {
	const strays = await strayRecords()
	if (strays.length === 0) {
		console.log(`  no strays: nothing named "${LITTER_PREFIX}…" is left on the board`)
		return
	}
	console.log(`  ${strays.length} stray record(s) found by name; removing`)
	// Tasks first so a bucket delete is a delete rather than a cascade, and one
	// submission each because a delete collection cannot hold a container and its
	// contents. Tolerated throughout: a record taken by a cascade answers not-found, and
	// that is the outcome we wanted anyway.
	const order = { bucket: 1, goal: 3, sprint: 2, task: 0 } as const
	let removed = 0
	for (const stray of [...strays].sort((a, b) => order[a.kind] - order[b.kind])) {
		try {
			await submitOperationSet(client, {
				Description: "ContextLayer: sweep strays",
				ProjectId: SCRATCH_PROJECT_ID,
				writes: [{ entity: stray.entity, verb: "delete" }],
			})
			removed += 1
		} catch (error) {
			if (!(error instanceof ScheduleApiError)) throw error
			// Not reported, and not counted as a failure — see the verification below.
		}
	}
	// VERIFY BY LOOKING, NOT BY COUNTING SUCCESSES. A refused delete is not evidence
	// that a record survived: the commonest refusal here is for a record a cascade
	// already took, its bucket or its parent having gone first, which answers not-found
	// — and when the service cannot write its own error log, that arrives as a 403 about
	// a privilege instead.
	//
	// So the question a sweep must answer is not "did every delete succeed" but "is
	// anything still there", and the only honest way to answer it is to look again.
	const survivors = await strayRecords()
	if (survivors.length === 0) {
		console.log(
			`  board clean: ${removed} delete(s) landed, and nothing named "${LITTER_PREFIX}…" remains`,
		)
		return
	}
	console.log(
		`  !! ${survivors.length} stray record(s) STILL on the board: ${survivors
			.map((s) => `${s.kind} "${s.label}"`)
			.join(", ")}`,
	)
	process.exitCode = 1
}

async function releaseOpenOperationSets(): Promise<void> {
	let released = 0
	let wedged = 0
	let unexpectedError: unknown
	for (const operationSetId of [...openSets]) {
		try {
			// The seam removes it from the ledger on the accepted abandon; this only counts.
			await api().abandonOperationSet({ OperationSetId: operationSetId })
			released += 1
		} catch (error) {
			if (!(error instanceof ScheduleApiError)) {
				unexpectedError ??= error
				continue
			}
			// "not in open state" proves only that the set costs no open-set quota and
			// cannot be reclaimed. The recorded instances are executing wedges, but this
			// response alone does not establish their status.
			if (error.responseBody.includes("not in open state")) {
				openSets.delete(operationSetId)
				wedged += 1
				continue
			}
			console.log(`  !! could not release ${operationSetId} — ${error.message}`)
		}
	}
	if (released > 0) console.log(`  released ${released} operation set(s) left open`)
	if (wedged > 0) {
		console.log(`  ${wedged} set(s) not open — costing no quota and not abandonable`)
	}
	if (openSets.size > 0) {
		console.log(
			`  !! ${openSets.size} operation sets STILL OPEN against this user's quota: ${[...openSets].join(", ")}`,
		)
		// The fixture is still valid — but a run that leaked quota slots must not LOOK
		// clean: the leak's only other symptom is the NEXT run failing for no visible
		// reason.
		process.exitCode = 1
	}
	if (unexpectedError !== undefined) throw unexpectedError
}

// --------------------------------------------------------------------- write
// Preflight is OUTSIDE the cleanup-owning scope. If it refuses the destination, no
// cleanup call is allowed to turn "nothing was written" into a write of its own.
await preflight()
try {
	await main()
} finally {
	// `sweep()` disables capture permanently, so cleanup needs no chain label.
	try {
		await sweep()
	} finally {
		await releaseOpenOperationSets()
	}
}

/**
 * What must be true of the recording AS A WHOLE — checkable only once, at the end.
 *
 * `executing` is the state `wait_for_operation_set` exists to handle, and it is the
 * one thing here that is DISCOVERED rather than constructed: whether a poll catches a
 * set mid-flight depends on how busy the org was. A quiet org can settle every set on
 * its first read, and the run would finish green with a cassette that cannot exercise
 * the poll loop at all. So it is asserted rather than hoped for; if it ever fires,
 * the answer is to re-run, not to weaken the gate.
 */
function auditRecording(): void {
	const progressed = executingProgressions(interactions)
	if (progressed.length === 0) {
		throw new Error(
			"no operation set was recorded going EXECUTING -> terminal on one path — the org settled everything before the first poll, so this cassette cannot exercise the wait loop. Re-run; do not weaken this check.",
		)
	}
	console.log(
		`  ${progressed.length} sets recorded a real executing -> terminal progression`,
	)
}

auditCassette()
auditRecording()

mkdirSync(OUT, { recursive: true })
const cassette = cassetteSchema.parse({
	api: "dataverse-project-schedule-v9.2",
	interactions,
	note: "Recorded AND normalized in one pass by lib/cassette/record.ts, which DRIVES the production client rather than building requests — so every chain holds exactly the request sequence production emits. Never hand-edit: change the script and re-run. Shapes and SEQUENCES only — no timing. Every poll of an operation set is recorded, at the cadence the product polls at, because the wait tool is itself a poll loop.",
	recordedBy: "lib/cassette/record.ts",
})
writeFileSync(`${OUT}schedule-api.json`, `${JSON.stringify(cassette, null, "\t")}\n`)
const byChain = interactions.reduce<Record<string, number>>((acc, i) => {
	acc[i.chain] = (acc[i.chain] ?? 0) + 1
	return acc
}, {})
console.log(`\nwrote ${OUT}schedule-api.json`)
console.log(
	`  ${interactions.length} interactions across ${Object.keys(byChain).length} chains`,
)
console.log(`  ${JSON.stringify(byChain, null, 1)}`)
