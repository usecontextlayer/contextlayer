import type { JWK, JWTVerifyGetKey } from "jose"
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from "jose"
import { beforeAll, describe, expect, it } from "vitest"
import type { CtxTokenVerifyResult } from "@/index"
import {
	CTX_TOKEN_AUDIENCE,
	createCtxTokenVerifier,
	createDevJwtVerifier,
	ctxTokenIssuer,
	ctxTokenJwksUrl,
	remoteCtxTokenJwks,
} from "@/index"

const ISSUER = "https://auth.example.test/api/auth"
const KID = "ctx-test-key-1"

let signingKey: CryptoKey
let jwks: JWTVerifyGetKey
let verify: (token: string) => Promise<CtxTokenVerifyResult>

type TokenClaims = {
	audience?: string | string[]
	azp?: unknown
	client_id?: unknown
	expirationTime?: number | string | Date
	issuer?: string
	key?: CryptoKey
	sub?: unknown
}

async function signToken(claims: TokenClaims): Promise<string> {
	const payload: Record<string, unknown> = {
		azp: claims.azp,
		client_id: claims.client_id,
		sub: claims.sub,
	}
	const jwt = new SignJWT(payload)
		.setProtectedHeader({ alg: "EdDSA", kid: KID })
		.setIssuedAt()
		.setIssuer(claims.issuer ?? ISSUER)
		.setAudience(claims.audience ?? CTX_TOKEN_AUDIENCE)
		.setExpirationTime(claims.expirationTime ?? "5m")
	return jwt.sign(claims.key ?? signingKey)
}

beforeAll(async () => {
	const pair = await generateKeyPair("EdDSA", { extractable: true })
	signingKey = pair.privateKey
	const publicJwk: JWK = {
		...(await exportJWK(pair.publicKey)),
		alg: "EdDSA",
		kid: KID,
	}
	jwks = createLocalJWKSet({ keys: [publicJwk] })
	verify = createCtxTokenVerifier({ issuer: ISSUER, jwks })
})

describe("createCtxTokenVerifier", () => {
	it("accepts a valid user ctx token and returns its sub", async () => {
		const token = await signToken({ sub: "user_123" })
		expect(await verify(token)).toEqual({ kind: "user", ok: true, sub: "user_123" })
	})

	it("accepts a token whose aud is an array containing urn:ctx:platform", async () => {
		const token = await signToken({
			audience: ["urn:ctx:platform", "https://other.audience"],
			sub: "user_123",
		})
		expect(await verify(token)).toEqual({ kind: "user", ok: true, sub: "user_123" })
	})

	it("accepts a machine token whose sub equals client_id", async () => {
		const token = await signToken({
			client_id: "machine_client_1",
			sub: "machine_client_1",
		})
		expect(await verify(token)).toEqual({
			clientId: "machine_client_1",
			kind: "machine",
			ok: true,
		})
	})

	it("treats an OAuth human token whose sub differs from client_id as a user", async () => {
		const token = await signToken({
			azp: "machine_client_1",
			client_id: "machine_client_1",
			sub: "user_123",
		})
		expect(await verify(token)).toEqual({ kind: "user", ok: true, sub: "user_123" })
	})

	it.each(["ctx", "not-ctx"])(
		"rejects audience %s after the cutover",
		async (audience) => {
			const token = await signToken({ audience, sub: "user_123" })
			expect(await verify(token)).toMatchObject({
				ok: false,
				reason: "ERR_JWT_CLAIM_VALIDATION_FAILED",
			})
		},
	)

	it("rejects a token with the wrong issuer", async () => {
		const token = await signToken({
			issuer: "https://evil.example.test/api/auth",
			sub: "user_123",
		})
		expect(await verify(token)).toMatchObject({
			ok: false,
			reason: "ERR_JWT_CLAIM_VALIDATION_FAILED",
		})
	})

	it("rejects an expired token", async () => {
		const token = await signToken({
			expirationTime: new Date(Date.now() - 60_000),
			sub: "user_123",
		})
		expect(await verify(token)).toMatchObject({
			ok: false,
			reason: "ERR_JWT_EXPIRED",
		})
	})

	it("carries the full jose error on a rejected token", async () => {
		const token = await signToken({ audience: "not-ctx", sub: "user_123" })
		const result = await verify(token)
		if (result.ok) {
			throw new Error("expected the token to be rejected")
		}
		expect(result.error).toBeInstanceOf(errors.JWTClaimValidationFailed)
		expect(result.error?.code).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED")
		expect(result.error?.message).toBeTruthy()
	})

	it("rejects a token signed by an unknown key", async () => {
		const other = await generateKeyPair("EdDSA", { extractable: true })
		const token = await signToken({ key: other.privateKey, sub: "user_123" })
		expect(await verify(token)).toMatchObject({ ok: false })
	})

	it("rejects an unsigned alg:none token (client input, never an infra throw)", async () => {
		// Found live 2026-07-03: jose throws ERR_JOSE_NOT_SUPPORTED for a header
		// naming an algorithm it won't run, and the loud-path default turned that
		// into a 500. A hostile/malformed token must reject like any other.
		const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url")
		const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
			aud: CTX_TOKEN_AUDIENCE,
			iss: ISSUER,
			sub: "user_123",
		})}.`
		expect(await verify(token)).toMatchObject({
			ok: false,
			reason: "ERR_JOSE_NOT_SUPPORTED",
		})
	})

	it("rejects a well-formed token that carries no principal", async () => {
		const token = await signToken({})
		expect(await verify(token)).toEqual({ ok: false, reason: "missing_principal" })
	})

	it("rethrows a non-jose infrastructure error from the jwks resolver", async () => {
		const failing: JWTVerifyGetKey = async () => {
			throw new Error("connection refused")
		}
		const verifyInfra = createCtxTokenVerifier({ issuer: ISSUER, jwks: failing })
		const token = await signToken({ sub: "user_123" })
		await expect(verifyInfra(token)).rejects.toThrow("connection refused")
	})

	it("rethrows a jwks timeout instead of masking it as an invalid token", async () => {
		const timingOut: JWTVerifyGetKey = async () => {
			throw new errors.JWKSTimeout()
		}
		const verifyInfra = createCtxTokenVerifier({ issuer: ISSUER, jwks: timingOut })
		const token = await signToken({ sub: "user_123" })
		await expect(verifyInfra(token)).rejects.toThrow(errors.JWKSTimeout)
	})
})

describe("createDevJwtVerifier", () => {
	const verifyDev = createDevJwtVerifier()

	it("decodes a token's sub WITHOUT verifying its signature", async () => {
		// Signed by a key the verifier has never seen — the real verifier rejects this
		// (see "rejects a token signed by an unknown key" above), but decode-only trusts
		// the claims: this is the whole point of CTX_AUTH_SKIP_VERIFY_JWT dev mode.
		const other = await generateKeyPair("EdDSA", { extractable: true })
		const token = await signToken({ key: other.privateKey, sub: "user_123" })
		expect(await verifyDev(token)).toEqual({ kind: "user", ok: true, sub: "user_123" })
	})

	it("ignores audience and issuer (there is no AS to check them against)", async () => {
		const token = await signToken({
			audience: "not-ctx",
			issuer: "https://evil.example.test/api/auth",
			sub: "user_9",
		})
		expect(await verifyDev(token)).toEqual({ kind: "user", ok: true, sub: "user_9" })
	})

	it("classifies a machine token whose sub equals client_id", async () => {
		const token = await signToken({ client_id: "machine_1", sub: "machine_1" })
		expect(await verifyDev(token)).toEqual({
			clientId: "machine_1",
			kind: "machine",
			ok: true,
		})
	})

	it("returns missing_principal for a token with no principal", async () => {
		const token = await signToken({})
		expect(await verifyDev(token)).toEqual({ ok: false, reason: "missing_principal" })
	})

	it("rejects (not throws) a malformed token, mirroring the prod verifier's contract", async () => {
		// The bridge's `?token=` default is "" and a stale browser token is garbage —
		// both must land on the same 401/4401 path as prod, not an unhandled throw
		// (decode-only has no infrastructure; every failure here is a token problem).
		expect(await verifyDev("")).toEqual({
			error: expect.any(errors.JWTInvalid),
			ok: false,
			reason: "ERR_JWT_INVALID",
		})
		expect(await verifyDev("not-a-jwt")).toEqual({
			error: expect.any(errors.JWTInvalid),
			ok: false,
			reason: "ERR_JWT_INVALID",
		})
	})
})

describe.each(["production", "development"])("%s principal claims", (mode) => {
	const verifyToken =
		mode === "production" ? (token: string) => verify(token) : createDevJwtVerifier()

	it.each([undefined, "", null, false, 42, {}, []])(
		"rejects invalid sub %j even with machine client metadata",
		async (sub) => {
			const token = await signToken({ azp: "machine_1", client_id: "machine_1", sub })
			expect(await verifyToken(token)).toEqual({
				ok: false,
				reason: sub === undefined ? "missing_principal" : "invalid_principal",
			})
		},
	)

	it.each(["", null, false, 42, {}, []])(
		"rejects present invalid client_id %j",
		async (client_id) => {
			const token = await signToken({ client_id, sub: "user_123" })
			expect(await verifyToken(token)).toEqual({ ok: false, reason: "invalid_principal" })
		},
	)

	it("rejects the old machine shape with azp and no sub", async () => {
		const token = await signToken({ azp: "machine_1" })
		expect(await verifyToken(token)).toEqual({ ok: false, reason: "missing_principal" })
	})

	it.each([undefined, "", null, false, 42, {}, [], "user_123", "machine_1"])(
		"ignores azp %j for first-party users, delegated users, and machines",
		async (azp) => {
			const firstParty = await signToken({ azp, sub: "user_123" })
			const user = await signToken({ azp, client_id: "machine_1", sub: "user_123" })
			const machine = await signToken({ azp, client_id: "machine_1", sub: "machine_1" })
			expect(await verifyToken(firstParty)).toEqual({
				kind: "user",
				ok: true,
				sub: "user_123",
			})
			expect(await verifyToken(user)).toEqual({ kind: "user", ok: true, sub: "user_123" })
			expect(await verifyToken(machine)).toEqual({
				clientId: "machine_1",
				kind: "machine",
				ok: true,
			})
		},
	)
})

describe("ctx token url derivations", () => {
	it("derives the issuer from the web url", () => {
		expect(ctxTokenIssuer("https://auth.example.test")).toBe(
			"https://auth.example.test/api/auth",
		)
	})

	it("derives the jwks url from the web url", () => {
		expect(ctxTokenJwksUrl("https://auth.example.test")).toBe(
			"https://auth.example.test/api/auth/jwks",
		)
	})

	it("builds a remote jwks resolver function from the web url", () => {
		expect(typeof remoteCtxTokenJwks("https://auth.example.test")).toBe("function")
	})
})
