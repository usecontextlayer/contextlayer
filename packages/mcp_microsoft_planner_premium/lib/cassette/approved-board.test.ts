import { describe, expect, it } from "vitest"
import {
	BoardGuardViolation,
	createBoardGuard,
	ORG_URL,
	SCRATCH_BUCKET_ID,
	SCRATCH_PROJECT_ID,
} from "@/lib/cassette/approved-board"

const STAGE_ACTION_URL = `${ORG_URL}/api/data/v9.2/msdyn_PssCreateV2`
const UNREGISTERED_RECORD_ID = "9f1c7d24-0b6e-4a35-8c72-1de905b4f6a3"

describe("the approved-board guard", () => {
	it("lets through a request naming only ids this run registered", () => {
		const guard = createBoardGuard()
		guard.registerOwnedId(SCRATCH_PROJECT_ID)
		guard.registerOwnedId(SCRATCH_BUCKET_ID)
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({
					entity: { bucket: SCRATCH_BUCKET_ID },
					ProjectId: SCRATCH_PROJECT_ID,
				}),
			),
		).not.toThrow()
	})

	it("lets through a request that names no records at all", () => {
		const guard = createBoardGuard()
		expect(() =>
			guard.assertRequestWithinApprovedBoard("POST", `${ORG_URL}/api/data/v9.2/WhoAmI`),
		).not.toThrow()
	})

	it("refuses an id nobody registered", () => {
		const guard = createBoardGuard()
		guard.registerOwnedId(SCRATCH_PROJECT_ID)
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({ id: UNREGISTERED_RECORD_ID }),
			),
		).toThrow(BoardGuardViolation)
	})

	it("refuses an unregistered id that appears in the URL rather than the body", () => {
		const guard = createBoardGuard()
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"GET",
				`${ORG_URL}/api/data/v9.2/msdyn_operationsets(${UNREGISTERED_RECORD_ID})?$select=msdyn_status`,
			),
		).toThrow(BoardGuardViolation)
	})

	it("refuses any organisation but the approved one, before looking at ids", () => {
		const guard = createBoardGuard()
		guard.registerOwnedId(SCRATCH_PROJECT_ID)
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				"https://someone-else.crm3.dynamics.com/api/data/v9.2/msdyn_PssCreateV2",
				JSON.stringify({ ProjectId: SCRATCH_PROJECT_ID }),
			),
		).toThrow(/may only ever reach/)
	})

	it("refuses a host that only starts with the approved origin", () => {
		const guard = createBoardGuard()
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"GET",
				`${ORG_URL}.evil.example/api/data/v9.2/WhoAmI`,
			),
		).toThrow(BoardGuardViolation)
	})

	it("warns against widening the allowlist rather than just naming the id", () => {
		const guard = createBoardGuard()
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({ id: UNREGISTERED_RECORD_ID }),
			),
		).toThrow(/Widening the allowlist to make this message go away is never the fix/)
	})

	it("says plainly that nothing was sent, so the reader knows the board is untouched", () => {
		const guard = createBoardGuard()
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({ id: UNREGISTERED_RECORD_ID }),
			),
		).toThrow(/Nothing was sent/)
	})

	it("matches ids without regard to case", () => {
		const guard = createBoardGuard()
		guard.registerOwnedId(SCRATCH_PROJECT_ID.toUpperCase())
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({ ProjectId: SCRATCH_PROJECT_ID.toLowerCase() }),
			),
		).not.toThrow()
	})

	it("refuses on the first stranger even when approved ids surround it", () => {
		const guard = createBoardGuard()
		guard.registerOwnedId(SCRATCH_PROJECT_ID)
		guard.registerOwnedId(SCRATCH_BUCKET_ID)
		expect(() =>
			guard.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({
					a: SCRATCH_PROJECT_ID,
					b: UNREGISTERED_RECORD_ID,
					c: SCRATCH_BUCKET_ID,
				}),
			),
		).toThrow(BoardGuardViolation)
	})

	it("does not share approvals between guards", () => {
		const first = createBoardGuard()
		first.registerOwnedId(UNREGISTERED_RECORD_ID)
		const second = createBoardGuard()
		expect(() =>
			second.assertRequestWithinApprovedBoard(
				"POST",
				STAGE_ACTION_URL,
				JSON.stringify({ id: UNREGISTERED_RECORD_ID }),
			),
		).toThrow(BoardGuardViolation)
	})
})
