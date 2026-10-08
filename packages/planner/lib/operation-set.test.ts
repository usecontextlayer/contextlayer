// The wait schedule, on its own.
//
// `readInstants` is a pure function of one number, and it is the only place the
// polling rhythm is decided — so it is checked here directly rather than inferred
// from HTTP traffic through two layers and a clock. The behaviour that DOES need the
// wire (early exit, what each status reports) lives in server.test.ts.

import { describe, expect, it } from "vitest"
import { MAX_WAIT_SECONDS, readInstants } from "@/lib/operation-set"

describe("readInstants", () => {
	it.each([
		{ instants: [0], label: "a glance: one read, no wait", seconds: 0 },
		{ instants: [0, 1], label: "shorter than one interval", seconds: 1 },
		{
			instants: [0, 4],
			label: "exactly one interval — the bell IS the tick",
			seconds: 4,
		},
		{ instants: [0, 4, 5], label: "a tick, then a short tail", seconds: 5 },
		{ instants: [0, 4, 8, 10], label: "the tail gets its own look", seconds: 10 },
		{ instants: [0, 4, 8, 12], label: "the cadence lands on the bell", seconds: 12 },
	])("$label ($seconds s)", ({ instants, seconds }) => {
		expect(readInstants(seconds)).toEqual(instants)
	})

	it("always reads immediately, whatever the window", () => {
		for (let seconds = 0; seconds <= MAX_WAIT_SECONDS; seconds++) {
			expect(readInstants(seconds)[0]).toBe(0)
		}
	})

	it("never reads past the window the caller asked for", () => {
		for (let seconds = 0; seconds <= MAX_WAIT_SECONDS; seconds++) {
			const instants = readInstants(seconds)
			expect(instants.at(-1)).toBe(seconds)
			expect(Math.max(...instants)).toBeLessThanOrEqual(seconds)
		}
	})

	it("never reads the same instant twice", () => {
		// The bell coinciding with a tick is one read, not two — 12s is 0/4/8/12, and a
		// duplicate would spend a Dataverse call to learn nothing.
		for (let seconds = 0; seconds <= MAX_WAIT_SECONDS; seconds++) {
			const instants = readInstants(seconds)
			expect(new Set(instants).size).toBe(instants.length)
			expect([...instants]).toEqual([...instants].sort((a, b) => a - b))
		}
	})

	it("leaves request headroom at full stretch", () => {
		const instants = readInstants(MAX_WAIT_SECONDS)
		expect(instants.at(-1)).toBe(45)
		expect(instants.length).toBe(13)
	})
})
