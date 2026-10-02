import type { JWTPayload, JWTVerifyGetKey } from "jose"
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify } from "jose"
import { z } from "zod"
import { CTX_TOKEN_AUDIENCE } from "@/lib/ctx-token-audience"

/**
 * The verified principal behind a platform token. Our issuer sets `sub` to the
 * client ID for client_credentials; human tokens carry the web user ID instead.
 * This classification relies on issuer-generated user and client IDs; accepting
 * caller-selected IDs or new grant shapes requires revisiting it. The first-party
 * session mint deliberately omits `client_id`; its subject remains a human.
 * `azp` does not determine identity. Authorization belongs to createCtxAuthMiddleware.
 */
export type CtxTokenVerifyResult =
	| { ok: true; kind: "user"; sub: string }
	| { ok: true; kind: "machine"; clientId: string }
	| { ok: false; error?: errors.JOSEError; reason: string }

export type CtxTokenVerifierInput = {
	issuer: string
	jwks: JWTVerifyGetKey
}

/**
 * jose error codes that mean "the presented token is invalid" → reject (401),
 * `reason` is the code (for logging only). Anything else — a JWKS timeout, a
 * non-200 / unparseable keyset, a raw network failure — is OUR infrastructure
 * failing, not the client's token, and must surface loudly rather than be
 * masked as an invalid token. Unknown codes default to the loud path.
 * NOT_SUPPORTED is client input, not infra: jose throws it for a token whose
 * header names an algorithm it won't run (e.g. `alg:none`) — found live
 * 2026-07-03 as a 500 that should have been a 401.
 */
const TOKEN_REJECTED_CODES: ReadonlySet<string> = new Set([
	"ERR_JOSE_ALG_NOT_ALLOWED",
	"ERR_JOSE_NOT_SUPPORTED",
	"ERR_JWKS_NO_MATCHING_KEY",
	"ERR_JWS_INVALID",
	"ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
	"ERR_JWT_CLAIM_VALIDATION_FAILED",
	"ERR_JWT_EXPIRED",
	"ERR_JWT_INVALID",
])

export function ctxTokenIssuer(webUrl: string): string {
	return `${webUrl}/api/auth`
}

export function ctxTokenJwksUrl(webUrl: string): string {
	return `${webUrl}/api/auth/jwks`
}

/**
 * The production JWKS resolver. Construct once per web URL and reuse — the
 * remote set refetches on an unknown `kid` and serves rotated keys through the
 * signing key's grace window.
 */
export function remoteCtxTokenJwks(webUrl: string): JWTVerifyGetKey {
	return createRemoteJWKSet(new URL(ctxTokenJwksUrl(webUrl)))
}

/**
 * Build an offline platform token verifier over an explicit JWKS resolver.
 * Production composes it with {@link remoteCtxTokenJwks}; tests compose it with
 * a local key set. jose accepts a string-or-array `aud`, so a token whose
 * audience is `["urn:ctx:platform", …]` still verifies.
 */
export function createCtxTokenVerifier(
	input: CtxTokenVerifierInput,
): (token: string) => Promise<CtxTokenVerifyResult> {
	return async function verifyCtxToken(token) {
		try {
			const { payload } = await jwtVerify(token, input.jwks, {
				audience: CTX_TOKEN_AUDIENCE,
				issuer: input.issuer,
			})
			return classifyPrincipal(payload)
		} catch (err) {
			if (err instanceof errors.JOSEError && TOKEN_REJECTED_CODES.has(err.code)) {
				return { error: err, ok: false, reason: err.code }
			}
			throw err
		}
	}
}

/**
 * The LOCAL-DEV verifier for `CTX_AUTH_SKIP_VERIFY_JWT` mode: DECODE the token and
 * trust its claims WITHOUT verifying the signature, issuer, audience, or time
 * claims, so local dev needs no web Authorization Server (no JWKS to fetch).
 * Principal validation and the result contract match {@link createCtxTokenVerifier}:
 * an invalid/absent principal returns `{ok:false}` (→ the consumer's 401/4401).
 * NEVER wire this in production —
 * the env prod-guards refuse to boot with `CTX_AUTH_SKIP_VERIFY_JWT` set.
 */
export function createDevJwtVerifier(): (token: string) => Promise<CtxTokenVerifyResult> {
	return async function verifyDevJwt(token) {
		let payload: JWTPayload
		try {
			payload = decodeJwt(token)
		} catch (err) {
			if (err instanceof errors.JOSEError && TOKEN_REJECTED_CODES.has(err.code)) {
				return { error: err, ok: false, reason: err.code }
			}
			throw err
		}
		return classifyPrincipal(payload)
	}
}

const principalClaimsSchema = z.object({
	client_id: z.string().min(1).optional(),
	sub: z.string().min(1),
})

function classifyPrincipal(payload: JWTPayload): CtxTokenVerifyResult {
	const parsed = principalClaimsSchema.safeParse(payload)
	if (!parsed.success) {
		return {
			ok: false,
			reason: payload.sub === undefined ? "missing_principal" : "invalid_principal",
		}
	}
	const { client_id, sub } = parsed.data
	return sub === client_id
		? { clientId: client_id, kind: "machine", ok: true }
		: { kind: "user", ok: true, sub }
}
