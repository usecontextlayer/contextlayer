// A per-fingerprint cap on Sentry error events, shipped as a `beforeSend` hook.
//
// Why a cap and not `sampleRate`: sampling is memoryless — `@sentry/core`'s
// client drops on `Math.random() > sampleRate` before the event is even
// fingerprinted — so a one-occurrence issue survives with probability `rate`.
// Measured against our own 39-issue history, `sampleRate: 0.25` loses 12 issues
// and 6 of 8 singletons. A cap remembers what it has already reported, so the
// first event of a key it has never seen is ALWAYS sent: it can understate how
// often something recurs, but it can never hide that something happened.
//
// The cap is per-process, which bounds a burst inside one long-lived process
// (the ctxb / ctxe / ctxs daemons) and nothing more. Processes that emit once
// and exit — short CLI commands, Dagster's per-run and per-step subprocesses —
// never reach it, so this is not a bound on total volume.
//
// This is a barrel-free entry (`@usecontextlayer/shared/sentry-event-cap`)
// because every Sentry init site imports it, including the browser bundle.
// Two constraints follow, and both are load-bearing:
//   - No `process.env` read. `process` is undefined in the browser, so each
//     call site passes the raw string it has: runtime env for the CLIs, the SSR
//     server and Python; a build-time define for the browser.
//   - No `@sentry/*` import. Both SDKs in play (node, react-router) are
//     deliberately kept EXTERNAL from their bundles because the OpenTelemetry
//     loader hooks break when inlined, so the event is typed structurally rather
//     than against any SDK's `Event`.
//
// `zod` is the one dependency, matching the repo's env-coercion convention
// (`portSchema` in slate-bridge, `CTX_PLATFORM_PORT` in platform).

import { z } from "zod"

// A UUID contains digit runs, so it must be collapsed BEFORE they are — the
// reverse order shreds it into fragments and every event keys differently.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// Six, not three: status codes, exit codes, and ports are 3-5 digits and DISTINGUISH
// defects, so collapsing them gave `HTTP 401` and `HTTP 500` one shared budget and a
// 401 storm could bury the first 500. A longer run is the only kind certain to be an
// identifier, and erring long errs toward more keys — capping less rather than hiding
// something new, which is the whole reason this is a cap and not a sample rate.
const LONG_DIGIT_RUN_PATTERN = /\d{6,}/g

/**
 * The subset of a Sentry error event this module reads. Structural on purpose:
 * every SDK's `Event` satisfies it, so no SDK type import is needed.
 */
export type CappableEvent = {
	message?: string
	exception?: { values?: Array<{ value?: string }> }
}

/** A `beforeSend` hook: returns the event to send it, or `null` to drop it. */
export type CappedBeforeSend = <TEvent extends CappableEvent>(
	event: TEvent,
) => TEvent | null

// One decimal integer, optional sign. The regex is what keeps this close to the Python
// copy, which delegates to `int()` via `shared_plugins.values.require_non_negative_int`:
// `z.coerce.number()` alone also reads "1e3" as 1000 and "0x10" as 16, both of which
// `int()` rejects, so one env value would have capped the CLIs while leaving the Dagster
// child uncapped. A leading `-` is matched here and refused by `positive()`, so a
// negative reports as out-of-range rather than as malformed syntax.
//
// The two are close but NOT identical, and that gap is known and accepted:
// `int()` also accepts PEP 515 underscores ("1_000") and non-ASCII decimal digits, which
// this ASCII-only regex rejects. A value in either form would cap the Dagster child and
// leave every TypeScript surface uncapped. Judged not worth closing for a value an
// operator types once — revisit if it ever bites.
const capSchema = z
	.string()
	.trim()
	.regex(/^[+-]?\d+$/)
	.transform(Number)
	.pipe(z.number().int().positive())

/**
 * Reads the `SENTRY_CAP_EVENTS` contract: a positive integer enables capping and
 * IS the cap. Absent, blank, or unparseable yields `undefined` — capping off.
 */
export function parseSentryEventCap(raw: string | undefined): number | undefined {
	const result = capSchema.safeParse(raw)
	return result.success ? result.data : undefined
}

/**
 * The composed form every init site uses: parse the raw env value and build the
 * hook in one call — `undefined` (capping off) when the value doesn't parse.
 */
export function sentryEventCapBeforeSend(
	raw: string | undefined,
): CappedBeforeSend | undefined {
	const cap = parseSentryEventCap(raw)
	return cap === undefined ? undefined : createCappedBeforeSend(cap)
}

/**
 * Groups events by a normalized message and admits at most `cap` of each. Keys
 * a UUID- and digit-collapsed message so one defect reported across many runs
 * (`… <uuid> … <n> … STEP_FAILURE`) counts as one key, while genuinely distinct
 * defects that merely share a stack (54 different missing Dataverse columns
 * under one `ErrorResponse` frame) each keep their own budget.
 */
export function createCappedBeforeSend(cap: number): CappedBeforeSend {
	// Values stop at `cap`, but the number of KEYS does not: normalization collapses
	// the identifier shapes it knows and nothing else, so a process emitting endlessly
	// varied messages grows this map without bound. Accepted rather than evicted —
	// the map dies with its process, and forgetting a key would let an
	// already-reported defect report again, which is the one thing the cap must not do.
	const sentPerKey = new Map<string, number>()
	return (event) => {
		const key = normalizedKey(event)
		const sent = sentPerKey.get(key) ?? 0
		if (sent >= cap) {
			return null
		}
		sentPerKey.set(key, sent + 1)
		return event
	}
}

function normalizedKey(event: CappableEvent): string {
	// Message first, then the LAST exception value — the same precedence
	// `@sentry/core`'s own `getPossibleEventMessages` uses (`utils/eventUtils.ts`:
	// `event.exception.values[event.exception.values.length - 1]`).
	const raw = event.message ?? event.exception?.values?.at(-1)?.value ?? ""
	return raw.replace(UUID_PATTERN, "<uuid>").replace(LONG_DIGIT_RUN_PATTERN, "<n>")
}
