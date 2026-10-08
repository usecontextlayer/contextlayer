// `record.ts` guards generated output; these tests revalidate committed bytes so later
// edits cannot bypass the same invariants.
import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import { describe, expect, it } from "vitest"
import {
	cassetteSchema,
	collisions,
	duplicateScenarios,
	executingProgressions,
	leaks,
	operationSetReadSchema,
} from "@/lib/cassette/interaction"
import { recordedChains } from "@/lib/cassette/replay"

const RAW = readFileSync(
	fileURLToPath(new URL("../__goldens__/schedule-api.json", import.meta.url)),
	"utf8",
)
const cassette = cassetteSchema.parse(JSON.parse(RAW))
const { interactions } = cassette

describe("the recorded cassette", () => {
	it("carries no value that identifies the org it was recorded against", () => {
		expect(leaks(RAW)).toEqual([])
	})

	it("gives every interaction a distinct scenario name", () => {
		// Scenario names are documentation, not the routing key — but a name shared by
		// several interactions is the cheapest signal that a re-record silently merged
		// two things.
		expect(duplicateScenarios(interactions)).toEqual([])
	})

	it("never leaves a set-read path and its own row disagreeing about which set it is", () => {
		// The strongest single hand-edit detector in the file, and free: every read of
		// an operation set returns `msdyn_operationsetid`, so the id in the path and the
		// id in the body must be the same placeholder. Change either one in isolation —
		// which is what hand-editing looks like — and this fails.
		for (const i of interactions) {
			const inPath = i.request.path.match(/^msdyn_operationsets\((.+?)\)/)?.[1]
			if (inPath === undefined || i.response.status < 200 || i.response.status >= 300) {
				continue
			}
			const { msdyn_operationsetid: inBody } = operationSetReadSchema.parse(
				i.response.body,
			)
			expect(inBody, i.scenario).toBe(inPath)
		}
	})

	it("contains a set that was observed EXECUTING and then reaching a terminal status", () => {
		// `executing` is the one state the recorder DISCOVERS rather than constructs —
		// catching a set mid-flight depends on how busy the org was. A quiet org
		// produces a recording that looks complete and cannot exercise the wait loop at
		// all, which is the single most expensive way for a re-record to go wrong.
		// The definition (and the EXECUTING-only line it draws) lives in
		// interaction.ts, shared with record.ts's write-time gate.
		expect(executingProgressions(interactions).length).toBeGreaterThan(0)
	})

	it("offers every chain by a name a test can replay", () => {
		// `replaying` is the one selector the harness exposes. Both sides here derive
		// from the same committed bytes, so this cannot notice a re-record dropping a
		// chain (the tests that NAME chains notice, loudly, via `chainNamed`) — what
		// it pins is the replay's own indexing: a `byChain` that skipped or misfiled
		// interactions would disagree with the raw bytes here.
		expect(recordedChains.length).toBeGreaterThan(0)
		expect([...recordedChains].sort()).toEqual(
			[...new Set(interactions.map((i) => i.chain))].sort(),
		)
	})

	it("never holds two different questions on one routing key", () => {
		// Within a chain, several responses on one key must be a SEQUENCE — the same
		// request recorded at different moments, where time changed the answer (a poll
		// walking executing → completed). If the
		// requests differ, the recorder asked two different questions the replay cannot
		// tell apart: it serves the key's responses in arrival order, so one question
		// silently receives the other's recorded answer. There is deliberately NO
		// exception mechanism — the fix is one probe per set per chain, in record.ts,
		// never a carve-out here. The definition lives in interaction.ts, beside the
		// key, shared with the recorder's per-interaction gate.
		expect(collisions(interactions)).toEqual([])
	})

	it("keeps the note describing how it was made", () => {
		// A fixture that loses its provenance is one nobody knows how to regenerate, and
		// regenerating rather than editing is the whole discipline.
		expect(cassette.note).toContain("Never hand-edit")
	})
})
