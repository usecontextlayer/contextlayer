import { MIMEType } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createMachineTokenProvider,
	resolveMachineTokenProvider,
} from "@/lib/ctx-machine-token"

const TOKEN_URL = "http://localhost:3000/api/auth/oauth2/token"

// A `fetch`-shaped mock whose body is supplied per test. Typing the params (vs a
// bare `vi.fn(async () => …)`) keeps `mock.calls` inspectable and lets
// `toHaveBeenCalledWith` typecheck.
function fetchMock(
	impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
	return vi.fn(impl)
}

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
	return new Response(
		JSON.stringify({
			access_token: accessToken,
			expires_in: expiresIn,
			token_type: "Bearer",
		}),
		{ status: 200 },
	)
}

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("createMachineTokenProvider", () => {
	it("mints with client_credentials + resource=urn:ctx:platform + Basic auth", async () => {
		const fetchImpl = fetchMock(async (input, init) => {
			// Exercise the Fetch body codec: equivalent headers and form-field order
			// must work, while JSON mislabeled as a form must fail.
			const request = new Request(input, init)
			expect(request.url).toBe(TOKEN_URL)
			expect(request.method).toBe("POST")
			expect(request.headers.get("authorization")).toBe(
				`Basic ${Buffer.from("cid:secret").toString("base64")}`,
			)
			expect(new MIMEType(request.headers.get("content-type") ?? "").essence).toBe(
				"application/x-www-form-urlencoded",
			)
			const form = await request.formData()
			expect([...form.keys()]).toHaveLength(2)
			expect(Object.fromEntries(form)).toEqual({
				grant_type: "client_credentials",
				resource: "urn:ctx:platform",
			})
			return tokenResponse("tok-1")
		})
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		expect(await provider()).toBe("tok-1")
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("caches the token while it is fresh (no second mint)", async () => {
		vi.useFakeTimers()
		const fetchImpl = fetchMock(async () => tokenResponse("tok", 3600))
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		expect(await provider()).toBe("tok")
		// Still well inside the 1h TTL (and outside the 60s expiry skew).
		vi.advanceTimersByTime(3600_000 - 120_000)
		expect(await provider()).toBe("tok")
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("re-mints once the cached token enters the expiry skew", async () => {
		vi.useFakeTimers()
		let minted = 0
		const fetchImpl = fetchMock(async () => {
			minted += 1
			return tokenResponse(`tok-${minted}`, 3600)
		})
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		expect(await provider()).toBe("tok-1")
		// Inside the final 60s before expiry -> stale -> re-mint.
		vi.advanceTimersByTime(3600_000 - 59_000)
		expect(await provider()).toBe("tok-2")
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it("treats the exact skew boundary as stale (the off-by-one tick)", async () => {
		vi.useFakeTimers()
		let minted = 0
		const fetchImpl = fetchMock(async () => {
			minted += 1
			return tokenResponse(`tok-${minted}`, 3600)
		})
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		expect(await provider()).toBe("tok-1")
		// Exactly at `expiresAtMs - SKEW`: `Date.now() < expiresAtMs - SKEW` is false,
		// so this tick is stale and re-mints (60s = the 60_000ms skew).
		vi.advanceTimersByTime(3600_000 - 60_000)
		expect(await provider()).toBe("tok-2")
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it("single-flights concurrent mints into one request", async () => {
		let release: (response: Response) => void = () => {}
		const fetchImpl = fetchMock(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve
				}),
		)
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		const first = provider()
		const second = provider()
		release(tokenResponse("tok"))

		expect(await first).toBe("tok")
		expect(await second).toBe("tok")
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("throws loudly on a non-ok mint response", async () => {
		const fetchImpl = fetchMock(
			async () => new Response("denied", { status: 401, statusText: "Unauthorized" }),
		)
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		await expect(provider()).rejects.toThrow(/401/)
	})

	it("throws loudly on a malformed token response", async () => {
		const fetchImpl = fetchMock(
			async () => new Response(JSON.stringify({ not_a_token: true }), { status: 200 }),
		)
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		await expect(provider()).rejects.toThrow()
	})

	it("does not cache a failed mint — the next call retries", async () => {
		let attempt = 0
		const fetchImpl = fetchMock(async () => {
			attempt += 1
			return attempt === 1 ? new Response("boom", { status: 500 }) : tokenResponse("tok")
		})
		const provider = createMachineTokenProvider({
			clientId: "cid",
			clientSecret: "secret",
			fetchImpl,
			tokenUrl: TOKEN_URL,
		})

		await expect(provider()).rejects.toThrow()
		expect(await provider()).toBe("tok")
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})
})

describe("resolveMachineTokenProvider", () => {
	it("returns undefined when no machine creds are set", () => {
		expect(
			resolveMachineTokenProvider({ CTX_WEB_URL: "http://localhost:3000" }),
		).toBeUndefined()
	})

	it("throws on partial machine config (fail loud, no silent drop)", () => {
		// id without secret
		expect(() =>
			resolveMachineTokenProvider({
				CTX_MACHINE_CLIENT_ID: "cid",
				CTX_WEB_URL: "http://localhost:3000",
			}),
		).toThrow(/Incomplete machine-auth config/)
		// secret without id
		expect(() =>
			resolveMachineTokenProvider({
				CTX_MACHINE_CLIENT_SECRET: "secret",
				CTX_WEB_URL: "http://localhost:3000",
			}),
		).toThrow(/Incomplete machine-auth config/)
		// both creds but no web origin to mint against
		expect(() =>
			resolveMachineTokenProvider({
				CTX_MACHINE_CLIENT_ID: "cid",
				CTX_MACHINE_CLIENT_SECRET: "secret",
			}),
		).toThrow(/Incomplete machine-auth config/)
	})

	it("builds a provider that mints at the web origin's token endpoint", async () => {
		const fetchImpl = fetchMock(async () => tokenResponse("tok"))
		vi.stubGlobal("fetch", fetchImpl)

		const provider = resolveMachineTokenProvider({
			CTX_MACHINE_CLIENT_ID: "cid",
			CTX_MACHINE_CLIENT_SECRET: "secret",
			CTX_WEB_URL: "http://localhost:3000",
		})

		expect(provider).toBeTypeOf("function")
		expect(await provider?.()).toBe("tok")
		expect(fetchImpl).toHaveBeenCalledWith(TOKEN_URL, expect.anything())
	})
})
