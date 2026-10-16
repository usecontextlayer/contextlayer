// Lifecycle failures and the wait schedule.
//
// `readInstants` is a pure function of one number, and it is the only place the
// polling rhythm is decided — so it is checked here directly rather than inferred
// from HTTP traffic through two layers and a clock. MCP results and native status
// reads are exercised in server.test.ts.

import { UnsecuredJWT } from "jose"
import { describe, expect, it } from "vitest"
import { serveRecordedOrg } from "@/lib/cassette/replay"
import {
	MAX_WAIT_SECONDS,
	OperationSetSubmissionError,
	readInstants,
	submitOperationSet,
} from "@/lib/operation-set"
import { createScheduleApiClient, ScheduleApiError } from "@/lib/schedule-api"

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

describe("submission failures", () => {
	it.each([false, true])(
		"preserves the receipt and staging cause when abandoning also fails: %s",
		async (abandonFails) => {
			const org = await serveRecordedOrg({ replaying: "reject-unknown-bucket" })
			const api = createScheduleApiClient({
				accessToken: new UnsecuredJWT({ scp: "user_impersonation" }).encode(),
				orgUrl: org.url,
			})
			const abandonError = new Error("Cleanup connection lost")
			try {
				const failure = await submitOperationSet(
					{
						...api,
						...(abandonFails
							? {
									abandonOperationSet: async () => {
										throw abandonError
									},
								}
							: {}),
					},
					{
						Description: "Create into an unknown bucket",
						ProjectId: "9c8b7a65-4321-f011-8dcb-0a1b2c3d4e5f",
						writes: [
							{
								entity: {
									"@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
									"msdyn_project@odata.bind":
										"/msdyn_projects(9c8b7a65-4321-f011-8dcb-0a1b2c3d4e5f)",
									"msdyn_projectbucket@odata.bind":
										"/msdyn_projectbuckets(1f2e3d4c-5b6a-f011-9e8d-7c6b5a4f3e2d)",
									msdyn_projecttaskid: "5a4b3c2d-1e0f-f011-b7a6-9d8c7b6a5f4e",
									msdyn_subject: "Task in an unknown bucket",
								},
								verb: "create",
							},
						],
					},
				).catch((error: unknown) => error)

				expect(failure).toBeInstanceOf(OperationSetSubmissionError)
				if (!(failure instanceof OperationSetSubmissionError)) throw failure
				expect(failure.receipt).toEqual({ OperationSetId: org.mintedOperationSetIds[0] })
				const cause = failure.cause
				if (abandonFails) {
					expect(cause).toBeInstanceOf(AggregateError)
					if (!(cause instanceof AggregateError)) throw cause
					expect(cause.errors[1]).toBe(abandonError)
				}
				const stagingError = cause instanceof AggregateError ? cause.errors[0] : cause
				expect(stagingError).toBeInstanceOf(ScheduleApiError)
				expect(stagingError).toMatchObject({ path: "msdyn_PssCreateV2", status: 400 })
				expect(stagingError).toHaveProperty(
					"responseBody",
					expect.stringContaining("ScheduleAPI-AV-0006"),
				)
			} finally {
				await org.close()
			}
		},
	)
})
