import * as Sentry from "@sentry/node"
import { describe, expect, it } from "vitest"
import {
	createCappedBeforeSend,
	parseSentryEventCap,
	sentryEventCapBeforeSend,
} from "@/lib/sentry-event-cap"

// The cap is a `beforeSend` hook, so its real contract is "what the Sentry SDK ends
// up SENDING" — not what the function returns. These drive a real client and assert
// on the events that reach a capturing transport, which is the only way the event
// shapes (exception.values, message precedence, the ordering of a chained error) come
// from the SDK instead of from an assumption.
//
// The client is local — its own `Scope`, never `Sentry.init` — so nothing touches
// global SDK state and the tests stay hermetic and parallel-safe. Same shape as the
// repo's other real-SDK tests (`InMemoryTransport.createLinkedPair()` driving a real
// MCP client in slate-bridge's `module-servers.test.ts`).

// The `integrations` list is an opt-IN, not a filter. A hand-built `NodeClient` gets
// NO default integrations — `Sentry.init` assembles those, the constructor does not —
// so anything a test depends on has to be named here. `linkedErrors` is named because
// the chained-error case below cannot work without it. Nothing is being excluded: in
// particular `dedupe`, which would genuinely confound a cap test by dropping a repeat
// event, is a `@sentry/browser` default and was never in `@sentry/node`'s set.
function capturingClient(cap: number): {
	scope: Sentry.Scope
	flush: () => Promise<void>
	sent: Array<Record<string, unknown>>
} {
	const sent: Array<Record<string, unknown>> = []
	const client = new Sentry.NodeClient({
		beforeSend: createCappedBeforeSend(cap),
		dsn: "https://public@example.ingest.sentry.io/1",
		integrations: [Sentry.linkedErrorsIntegration()],
		stackParser: Sentry.defaultStackParser,
		transport: () => ({
			flush: () => Promise.resolve(true),
			send: (envelope) => {
				for (const item of envelope[1]) {
					if (item[0].type === "event") sent.push(item[1] as Record<string, unknown>)
				}
				return Promise.resolve({})
			},
		}),
	})
	client.init()
	const scope = new Sentry.Scope()
	scope.setClient(client)
	return {
		flush: async () => {
			await client.flush(5_000)
		},
		scope,
		sent,
	}
}

describe("sentryEventCapBeforeSend", () => {
	it("a parseable value yields a live capping hook; an unparseable one yields undefined", () => {
		const beforeSend = sentryEventCapBeforeSend("1")
		const event = { message: "same defect" }
		expect(beforeSend?.(event)).toBe(event)
		expect(beforeSend?.(event)).toBeNull()

		expect(sentryEventCapBeforeSend(undefined)).toBeUndefined()
		expect(sentryEventCapBeforeSend("off")).toBeUndefined()
	})
})

describe("parseSentryEventCap", () => {
	it("reads a positive integer as the cap, tolerating surrounding whitespace", () => {
		expect(parseSentryEventCap("25")).toBe(25)
		expect(parseSentryEventCap("1")).toBe(1)
		expect(parseSentryEventCap(" 25 ")).toBe(25)
	})

	it("treats absent, blank, and non-numeric values as capping-off", () => {
		expect(parseSentryEventCap(undefined)).toBeUndefined()
		expect(parseSentryEventCap("")).toBeUndefined()
		expect(parseSentryEventCap("   ")).toBeUndefined()
		expect(parseSentryEventCap("off")).toBeUndefined()
	})

	it("rejects a partially-numeric value rather than reading its prefix", () => {
		// Number.parseInt("25abc") is 25 — a typo must not silently become a cap.
		expect(parseSentryEventCap("25abc")).toBeUndefined()
		expect(parseSentryEventCap("2.5")).toBeUndefined()
	})

	it("rejects zero and negatives, which cannot express a usable cap", () => {
		expect(parseSentryEventCap("0")).toBeUndefined()
		expect(parseSentryEventCap("-5")).toBeUndefined()
	})

	it("rejects the exponent and hex forms that Number() alone would have accepted", () => {
		// The contract is a decimal integer with an optional sign. These two are where
		// `Number()` diverged from the Dagster child's `int()` — it read them as 1000
		// and 16 while `int()` refused them, so a single SENTRY_CAP_EVENTS value would
		// have capped the CLIs and left that process uncapped.
		//
		// This does NOT make the two parsers identical, and the test does not claim it:
		// `int()` also accepts "1_000" and non-ASCII digits, which this side rejects.
		// That gap is known and accepted — see the note in sentry-event-cap.ts.
		expect(parseSentryEventCap("+5")).toBe(5)
		expect(parseSentryEventCap("1e3")).toBeUndefined()
		expect(parseSentryEventCap("0x10")).toBeUndefined()
	})
})

describe("the cap, through a real Sentry client", () => {
	it("sends exactly `cap` events of one defect and drops the rest", async () => {
		const { scope, flush, sent } = capturingClient(3)
		for (let i = 0; i < 100; i++) scope.captureException(new Error("write ECONNRESET"))
		await flush()
		expect(sent).toHaveLength(3)
	})

	it("ALWAYS sends a defect it has never seen, even after another is exhausted", async () => {
		// The property that makes a cap lossless where sampling is not: a brand-new
		// defect is never dropped, no matter how much noise preceded it.
		const { scope, flush, sent } = capturingClient(2)
		for (let i = 0; i < 500; i++) scope.captureException(new Error("write ECONNRESET"))
		scope.captureException(new Error("operator does not exist: json <> jsonb"))
		await flush()
		expect(exceptionValues(sent)).toContain("operator does not exist: json <> jsonb")
	})

	it("gives each distinct defect its own budget", async () => {
		const { scope, flush, sent } = capturingClient(2)
		for (let i = 0; i < 10; i++) {
			scope.captureException(new Error('column "bodyx" does not exist'))
			scope.captureException(new Error('column "subject" does not exist'))
		}
		await flush()
		expect(sent).toHaveLength(4)
	})

	it("keeps status codes distinct, so a recurring 401 cannot bury the first 500", async () => {
		// The collision that set the 6-digit threshold: at `\d{3,}` both normalized to
		// `request failed with HTTP <n>` and shared one budget, so a 401 storm dropped
		// the 500 the moment it first appeared.
		const { scope, flush, sent } = capturingClient(1)
		for (let i = 0; i < 100; i++)
			scope.captureException(new Error("request failed with HTTP 401"))
		scope.captureException(new Error("request failed with HTTP 500"))
		await flush()
		expect(exceptionValues(sent)).toContain("request failed with HTTP 500")
	})

	it("collapses per-run identifiers so one recurring defect is one key", async () => {
		// Identical failure, fresh run UUID and run number each time. Without
		// normalization every event is a new key and the cap never fires.
		const { scope, flush, sent } = capturingClient(2)
		for (const [index, uuid] of [
			"fad83329-71f9-444b-8b13-ed193770e8fc",
			"02ece62e-4274-4619-9dd0-369183a36806",
			"f0d4f1e8-23ea-47bd-bac7-bf4512c8fcb2",
			"842d6283-f06b-491a-9ad6-245a8e7fbb3b",
		].entries()) {
			scope.captureMessage(
				`__ASSET_JOB - ${uuid} - ${402219 + index} - microsoft_mail_sync - STEP_FAILURE`,
			)
		}
		await flush()
		expect(sent).toHaveLength(2)
	})

	it("keys on the OUTERMOST error of a chain, which is the one the SDK puts last", async () => {
		// Verified against the SDK rather than assumed: with linkedErrors installed, a
		// cause chain arrives as [inner, outer], so keying on the last value keys on the
		// error actually thrown. Two different outers over a shared cause must therefore
		// keep separate budgets — if this ever keyed on the inner cause, the second
		// would be dropped and a distinct defect would vanish behind a shared cause.
		const { scope, flush, sent } = capturingClient(1)
		const shared = () => new Error("shared cause")
		scope.captureException(new Error("outer A", { cause: shared() }))
		scope.captureException(new Error("outer B", { cause: shared() }))
		await flush()
		expect(exceptionValues(sent)).toEqual(expect.arrayContaining(["outer A", "outer B"]))
	})

	it("caps a captureMessage by its text, alongside exceptions", async () => {
		const { scope, flush, sent } = capturingClient(1)
		for (let i = 0; i < 5; i++) scope.captureMessage("a recurring notice")
		scope.captureException(new Error("a recurring notice"))
		await flush()
		// Same text via two capture paths: the message and the exception normalize to
		// the same key, so the exception is dropped once the message spent the budget.
		expect(sent).toHaveLength(1)
	})

	it("keeps separate clients independent, so one init site cannot exhaust another", async () => {
		const first = capturingClient(1)
		const second = capturingClient(1)
		first.scope.captureException(new Error("boom"))
		second.scope.captureException(new Error("boom"))
		await first.flush()
		await second.flush()
		expect(first.sent).toHaveLength(1)
		expect(second.sent).toHaveLength(1)
	})
})

/** The last exception value of each captured event — what the cap keys on. */
function exceptionValues(
	sent: Array<Record<string, unknown>>,
): Array<string | undefined> {
	return sent.map((event) => {
		const exception = event.exception as
			| { values?: Array<{ value?: string }> }
			| undefined
		return exception?.values?.at(-1)?.value ?? (event.message as string | undefined)
	})
}
