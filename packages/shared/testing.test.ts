import { describe, expect, it } from "vitest"
import { createFixtureAuth } from "@/testing"

// The kit's own wiring, not the verifier's semantics (verify-ctx-token.test.ts
// owns those): every minter produces a token the fixture's PRODUCTION verifier
// accepts as the right principal, and the issuer override mints one it refuses.

describe("createFixtureAuth", () => {
	it("mints user and machine tokens its own verifier accepts", async () => {
		const auth = await createFixtureAuth()
		expect(await auth.verify(await auth.userToken("user-1"))).toEqual({
			kind: "user",
			ok: true,
			sub: "user-1",
		})
		expect(await auth.verify(await auth.machineToken("client-1"))).toEqual({
			clientId: "client-1",
			kind: "machine",
			ok: true,
		})
	})

	it("the issuer override mints a token the fixture's verifier refuses", async () => {
		const auth = await createFixtureAuth()
		const foreign = await auth.userToken("user-1", { issuer: "https://other.test" })
		expect((await auth.verify(foreign)).ok).toBe(false)
	})

	it("two fixtures do not trust each other's keys", async () => {
		const [a, b] = await Promise.all([createFixtureAuth(), createFixtureAuth()])
		expect((await a.verify(await b.userToken("user-1"))).ok).toBe(false)
	})
})
