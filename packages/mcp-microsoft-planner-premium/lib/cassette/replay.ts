// Replay only responses captured from the live organisation. A test selects one chain,
// then request identity routes within it; the test cannot invent responses or their
// sequence. Bodies are not byte-matched beyond the OperationSetId used by the key.
//
// WHY THE CHAIN IS THE SCOPE. Almost every request identifies itself: a GET's path
// carries the record id and the `$select`; execute, abandon and all staging actions
// name an OperationSetId the caller read out of an earlier response, so it matches
// byte for byte. The one request that cannot answer for itself is the operation-set CREATE —
// it MINTS its id rather than naming one, and the body it does carry is exactly
// what production can never reproduce: a `Description` built from user input, and a
// `ProjectId` the recording holds as a placeholder but a test supplies as a real
// GUID (the tools' `guid()` schemas see to that). Routing creates through a
// parallel status-keyed index answers that with a proxy — one that misfiles a
// successful create whose chain exists to record something else, and strands
// recorded creates unreachable. Scoping every lookup to the declared chain needs no
// special case at all: within one chain the creates ARE a sequence, served in
// recorded order, and everything downstream follows the ids they mint.
//
// The cost, accepted deliberately: a test replaying one chain cannot read a set
// from another. No test should — if one ever seems to need it, the RECORDING should
// carry that flow as one chain; do not add cross-chain lookup.
//
// Placeholders (`{{operationSet1}}`, `{{plainTaskId}}`, …) are served VERBATIM. The
// client under test reads an id out of one recorded body and puts it into the next
// keyed path or OperationSetId, so matching that identifier-bearing portion is exact.

import { once } from "node:events"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { text } from "node:stream/consumers"
import { fileURLToPath, URL } from "node:url"
import { Hono } from "hono"
import {
	authOf,
	cassetteSchema,
	type Interaction,
	jsonObjectSchema,
	keyOf,
	operationSetIdSchema,
	requiredOperationSetIdSchema,
} from "@/lib/cassette/interaction"

const cassette = cassetteSchema.parse(
	JSON.parse(
		readFileSync(
			fileURLToPath(new URL("../__goldens__/schedule-api.json", import.meta.url)),
			"utf8",
		),
	),
)

const CREATE_OPERATION_SET = "msdyn_CreateOperationSetV1"

type RecordedChain = {
	interactions: Map<string, Interaction[]>
	mintedOperationSetIds: string[]
}

const byChain = new Map<string, RecordedChain>()
for (const interaction of cassette.interactions) {
	const indexed = byChain.get(interaction.chain) ?? {
		interactions: new Map<string, Interaction[]>(),
		mintedOperationSetIds: [],
	}
	byChain.set(interaction.chain, indexed)
	const key = keyOf(interaction.request)
	indexed.interactions.set(key, [...(indexed.interactions.get(key) ?? []), interaction])
	if (
		interaction.request.path === CREATE_OPERATION_SET &&
		interaction.response.status >= 200 &&
		interaction.response.status < 300
	) {
		indexed.mintedOperationSetIds.push(
			requiredOperationSetIdSchema.parse(interaction.response.body).OperationSetId,
		)
	}
}

/** Every recorded conversation a test can replay, in recorded order. */
export const recordedChains: readonly string[] = [...byChain.keys()]

/** The chain's recorded facts — empty when a test declares no chain at all. */
function chainNamed(replaying: string | undefined): RecordedChain {
	if (replaying === undefined) {
		return { interactions: new Map(), mintedOperationSetIds: [] }
	}
	const scoped = byChain.get(replaying)
	if (scoped === undefined) {
		throw new Error(
			`No recorded chain "${replaying}". The cassette's chains are: ${recordedChains.join(", ")}.`,
		)
	}
	return scoped
}

export type ReplayedCall = {
	action: string
	authorization: string | undefined
	body: Record<string, unknown>
}
/** `path` keeps the QUERY STRING — the `$select` is production's column list, and holding it to account is why the recording contains a projection probe at all. */
export type ReplayedRead = { authorization: string | undefined; path: string }

export type RecordedOrg = {
	/** Every action POSTed, in order. */
	calls: ReplayedCall[]
	close: () => Promise<void>
	/**
	 * The OperationSetIds the replayed chain minted, in recorded order — the
	 * receipts a test hands to `wait_for_operation_set`. Read out of the recording
	 * (a create that minted carries the id in its response body; a rejected or
	 * unauthenticated one does not), so a test never keeps a hand-copied twin of
	 * the recorder's `registerNamedId()` calls.
	 */
	mintedOperationSetIds: readonly string[]
	/** Every record GET, in order, full path including the query string. */
	reads: ReplayedRead[]
	url: string
}

function toResponse(interaction: Interaction): Response {
	// An absent body is zero bytes on the wire, not the four bytes `null`. `hop`
	// reads the raw text into the message it throws, so serving `null` here would put
	// "401 Unauthorized — null" in front of an operator instead of "401 Unauthorized".
	const { status, statusText } = interaction.response
	return "body" in interaction.response
		? Response.json(interaction.response.body, { status, statusText })
		: new Response(null, { status, statusText })
}

/**
 * Stand up an org that replays one recorded chain. Caller closes it.
 *
 * `replaying` is omitted only by a test that drives NO recorded traffic (discovery
 * and argument-validation tests): a request against a chainless
 * org fails loudly.
 */
export async function serveRecordedOrg(options: {
	replaying?: string
}): Promise<RecordedOrg> {
	const { replaying } = options
	const chain = chainNamed(replaying)
	const scoped = chain.interactions

	const calls: ReplayedCall[] = []
	const reads: ReplayedRead[] = []
	const cursor = new Map<string, number>()

	function next(key: string, describe: string): Interaction {
		const recorded = scoped.get(key)
		if (recorded === undefined) {
			throw new Error(
				replaying === undefined
					? `This org is replaying no chain, and the code under test sent ${describe}. Declare the recorded conversation the test drives — \`serveRecordedOrg({ replaying })\`, one of: ${recordedChains.join(", ")}.`
					: `Chain "${replaying}" holds no recorded interaction for ${describe}. The cassette is the source of truth — if the real API does this, record it with lib/cassette/record.ts (in this chain); if it does not, the test should not ask for it.`,
			)
		}
		const at = cursor.get(key) ?? 0
		cursor.set(key, at + 1)
		const interaction = recorded[at]
		// EXHAUSTION THROWS rather than repeating the last response. Repeating a POST
		// would hand a second action the first one's answer; repeating a GET would invent
		// one more observation than the org produced. In either case, another response
		// belongs in another recording rather than in a clamp here.
		if (interaction === undefined) {
			throw new Error(
				`Recorded sequence exhausted for ${describe} in chain "${replaying}" — ${recorded.length} response(s) were captured and this is request ${at + 1}. The code under test issued a call the recording does not contain; record it with lib/cassette/record.ts, or fix the caller.`,
			)
		}
		return interaction
	}

	const app = new Hono()

	app.post("/api/data/v9.2/:action", async (c) => {
		const action = c.req.param("action")
		const authorization = c.req.header("Authorization")
		const body = jsonObjectSchema.parse(await c.req.json())
		calls.push({ action, authorization, body })
		const { OperationSetId: operationSetId } = operationSetIdSchema.parse(body)
		const named =
			operationSetId === undefined
				? ""
				: ` with OperationSetId ${JSON.stringify(operationSetId)}`
		return toResponse(
			next(
				keyOf({ auth: authOf(authorization), body, method: "POST", path: action }),
				`POST ${action}${named}`,
			),
		)
	})

	app.get("/api/data/v9.2/:record", (c) => {
		// `c.req.param` drops the query string; the `$select` is part of the identity.
		const path = new URL(c.req.url).pathname.replace("/api/data/v9.2/", "")
		const query = new URL(c.req.url).search
		const full = decodeURIComponent(path) + query
		const authorization = c.req.header("Authorization")
		reads.push({ authorization, path: full })
		return toResponse(
			next(
				keyOf({ auth: authOf(authorization), method: "GET", path: full }),
				`GET ${full}`,
			),
		)
	})

	const server = createServer(async (incoming, outgoing) => {
		const headers = new Headers()
		for (let at = 0; at < incoming.rawHeaders.length; at += 2) {
			headers.append(
				incoming.rawHeaders[at] as string,
				incoming.rawHeaders[at + 1] as string,
			)
		}
		const response = await app.request(incoming.url as string, {
			body: incoming.method === "POST" ? await text(incoming) : undefined,
			headers,
			method: incoming.method,
		})
		outgoing.writeHead(
			response.status,
			response.statusText,
			Object.fromEntries(response.headers),
		)
		outgoing.end(Buffer.from(await response.arrayBuffer()))
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()
	if (typeof address !== "object" || address === null) throw new Error("no port")

	return {
		calls,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
		mintedOperationSetIds: chain.mintedOperationSetIds,
		reads,
		url: `http://127.0.0.1:${address.port}`,
	}
}
