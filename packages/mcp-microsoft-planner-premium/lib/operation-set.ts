// The OperationSet lifecycle, as the two operations a caller can actually want:
// submit a set, and later ask what became of it.
//
// This is the layer between the wire (`schedule-api.ts`, one hop per call) and the
// MCP edge (`server.ts`, schemas and descriptions). It exists because sequencing a
// job API is domain logic with nothing tool-shaped about it — the same two
// operations would be wanted by anything driving this API, MCP or not.
//
// THE SPLIT IT ENFORCES IS THE POINT: the API accepts a set and applies it LATER,
// so "submit" and "did it land" are two questions, and a caller made to ask them
// separately is a caller being told the truth.
//
// What this layer deliberately does NOT hide is the SET. A submission is a
// transaction over many operations, and collapsing that into "one write" would be
// the same class of lie as pretending the write were synchronous. What it does
// collapse is the HTTP sequence that builds a set — open, one stage call per nonempty
// verb, execute. Those are mechanism, not meaning: nothing useful can happen between
// them, and a lost open-set id cannot be found again.

import { setTimeout as sleep } from "node:timers/promises"
import {
	OPERATION_SET_STATUS,
	type OperationSet,
	type OperationSetReceipt,
	type PssErrorLog,
	type ScheduleApiClient,
	type StagedWrite,
} from "@/lib/schedule-api"

/** The last native set row, plus its native linked error-log row on failure. */
export type WaitOutcome = [OperationSet] | [OperationSet, PssErrorLog]

/**
 * The rhythm, fixed. The caller chooses how long to wait; it never chooses how often
 * to look, because that is a property of the API's latency rather than of anything a
 * caller knows. The recorder's sequences come out at this cadence for the better reason:
 * it drives `waitForOperationSet` rather than polling by hand.
 */
const POLL_SECONDS = 4

/**
 * The longest window a caller may ask for. The MCP client gives up on any tool call
 * at 60s, and a timeout is strictly worse than an answer: `executing` preserves the
 * service's last reported state, while a timeout says nothing at all and invites a
 * retry of a write that is not idempotent. 45 leaves room for the reads themselves.
 */
export const MAX_WAIT_SECONDS = 45

/**
 * The order the verbs are staged in — creates, then updates, then deletes.
 *
 * Fixed rather than derived from the caller's list, because it is the order that was
 * driven against a real org and observed applying whole. Whether the service would
 * honour another order is unknown and not worth discovering by accident, and a
 * caller has no reason to care: the set is one transaction either way.
 */
const STAGING_ORDER = [
	"create",
	"update",
	"delete",
] as const satisfies readonly StagedWrite["verb"][]

/**
 * When to read, in seconds from the call: immediately, every `POLL_SECONDS`, and at
 * the closing bell. A list rather than a loop condition — the schedule is data, so
 * it can be read, tested, and argued about without a clock anywhere near it.
 *
 *   0  → [0]              a single read; the caller wanted a glance, not a wait
 *   10 → [0, 4, 8, 10]    the tail is short, and still gets its own look
 *   12 → [0, 4, 8, 12]    the cadence lands on the bell; one read, not two
 */
export function readInstants(seconds: number): number[] {
	const instants = [0]
	for (let at = POLL_SECONDS; at < seconds; at += POLL_SECONDS) instants.push(at)
	if (seconds > 0) instants.push(seconds)
	return instants
}

// `.message` IS THE INTERFACE. The MCP SDK reduces anything a tool throws to
// `error.message` before building its result, so `.cause` and `AggregateError.errors`
// never reach the caller. Everything an operator needs goes IN the string.
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Submit one operation set and hand back the receipt.
 *
 * ABANDON ONLY ON A STAGING FAILURE. A set whose staging threw holds a partial
 * transaction and is still open, so it would sit against the caller's open-set quota
 * forever with no API to find it again; abandoning it is accepted. After execute the
 * question does not arise — this returns the moment the service accepts, and what
 * happens to the set afterwards belongs to `waitForOperationSet`.
 *
 * Do NOT re-derive that rule from "a failed execute closes the set". That is only
 * half true: a set closes when the WORK fails and stays OPEN when the SET itself is
 * rejected (an empty one, for instance). The rule above holds either way; the
 * plausible-sounding premise does not.
 *
 * An EMPTY submission is the caller's to prevent. Executing a set with nothing
 * staged is rejected AND leaves the set open — the one execute failure that leaks a
 * quota slot — so the edge refuses it before a set is ever minted, rather than this
 * layer growing a branch for a call that should not have been made.
 */
export async function submitOperationSet(
	api: ScheduleApiClient,
	input: { Description: string; ProjectId: string; writes: StagedWrite[] },
): Promise<OperationSetReceipt> {
	const receipt = await api.createOperationSet({
		Description: input.Description,
		ProjectId: input.ProjectId,
	})

	try {
		const entitiesByVerb: Record<StagedWrite["verb"], Record<string, unknown>[]> = {
			create: [],
			delete: [],
			update: [],
		}
		for (const write of input.writes) entitiesByVerb[write.verb].push(write.entity)

		for (const verb of STAGING_ORDER) {
			const entities = entitiesByVerb[verb]
			// An empty collection is not staged at all. The action refuses one, and a
			// verb nobody asked for has no call to make.
			if (entities.length > 0) {
				await api.stage({ EntityCollection: entities, ...receipt, verb })
			}
		}
	} catch (error) {
		try {
			await api.abandonOperationSet(receipt)
		} catch (abandonError) {
			// Both causes go in the sentence. This is the quota-starvation path: the set
			// is stranded open, invisible, and cumulative, and an `AggregateError` would
			// surface the consequence while dropping both reasons for it.
			throw new Error(
				`Staging failed AND abandoning OperationSet '${receipt.OperationSetId}' failed — that set is now stranded open against the user's quota. Staging: ${reason(error)}. Abandon: ${reason(abandonError)}.`,
			)
		}
		throw error
	}

	// A rejection here is synchronous and immediate — an out-of-range field value
	// comes back as a 400 — so bad input reaches the caller now rather than as a
	// status read a minute later. The set is already closed; nothing to abandon.
	await api.executeOperationSet(receipt)
	return receipt
}

/**
 * Read the set on the schedule until it settles or the window closes.
 *
 * The first read sits before the loop because `readInstants` always opens at 0.
 * Lifting it out is what makes the two exits the same line of code: whether the set
 * settled or the caller simply ran out of window, the answer is the last thing the
 * set actually said.
 *
 * `executing` is not a promise of settlement. When the window closes, return the
 * last observed status rather than timing out and inviting a non-idempotent retry.
 */
export async function waitForOperationSet(
	api: ScheduleApiClient,
	input: { OperationSetId: string; seconds: number },
): Promise<WaitOutcome> {
	let elapsed = 0
	let set = await api.getOperationSet(input.OperationSetId)

	// Only `executing` earns another read: terminal states are final, and `open`
	// requires an explicit execute. Receipts minted by `submitOperationSet` are already
	// past open.
	for (const at of readInstants(input.seconds).slice(1)) {
		if (set.msdyn_status !== OPERATION_SET_STATUS.executing) break
		await sleep((at - elapsed) * 1000)
		elapsed = at
		set = await api.getOperationSet(input.OperationSetId)
	}

	return set.msdyn_status === OPERATION_SET_STATUS.failed
		? [set, await api.getPssErrorLog(set._msdyn_psserrorlog_value)]
		: [set]
}
