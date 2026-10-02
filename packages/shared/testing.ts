// Test-only fixture-JWKS auth kit — the one way a suite stands up REAL platform
// auth without a web Authorization Server: a fresh EdDSA keypair per call, the
// PRODUCTION verifier (`createCtxTokenVerifier`) over that key set, and minters
// for signed user/machine tokens the verifier accepts. Fenced behind the
// `./testing` export so the production surface
// never carries it. NOT for `verify-ctx-token.test.ts` — the verifier's own suite
// must not depend on a kit that wraps it.

import type { MiddlewareHandler } from "hono"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { type AppEnv, createCtxAuthMiddleware } from "@/lib/ctx-auth-middleware"
import { CTX_TOKEN_AUDIENCE } from "@/lib/ctx-token-audience"
import { type CtxTokenVerifyResult, createCtxTokenVerifier } from "@/lib/verify-ctx-token"

const FIXTURE_KID = "ctx-fixture-key-1"

export type FixtureAuth = {
	/** The PRODUCTION verifier, bound to this fixture's key set. */
	verify: (token: string) => Promise<CtxTokenVerifyResult>
	/** `createCtxAuthMiddleware(verify, machineClientIdAllowlist)` — ready to `app.use`. */
	authMiddleware: MiddlewareHandler<AppEnv>
	/** A signed user token (`sub` = identity). The `issuer` override exists for
	 * wrong-issuer rejection tests — any other use is minting a token this
	 * fixture's own verifier will refuse. */
	userToken: (sub: string, opts?: { issuer?: string }) => Promise<string>
	/** A platform `client_credentials` token: `sub === client_id`. */
	machineToken: (clientId: string) => Promise<string>
	/** The `Authorization: Bearer` request-init shorthand for `app.request`. */
	bearer: (token: string) => { headers: { Authorization: string } }
}

/**
 * One call for a suite's `beforeAll`. The allowlist is the suite's own choice
 * (defaults to empty = no machine admitted, the middleware's fail-closed
 * posture); the issuer only matters when a test needs to name it.
 */
export async function createFixtureAuth(opts?: {
	issuer?: string
	machineClientIdAllowlist?: Iterable<string>
}): Promise<FixtureAuth> {
	const issuer = opts?.issuer ?? "https://auth.fixture.test/api/auth"
	const pair = await generateKeyPair("EdDSA", { extractable: true })
	const publicJwk: JWK = {
		...(await exportJWK(pair.publicKey)),
		alg: "EdDSA",
		kid: FIXTURE_KID,
	}
	const verify = createCtxTokenVerifier({
		issuer,
		jwks: createLocalJWKSet({ keys: [publicJwk] }),
	})
	const sign = (jwt: SignJWT, tokenIssuer: string) =>
		jwt
			.setProtectedHeader({ alg: "EdDSA", kid: FIXTURE_KID })
			.setIssuedAt()
			.setIssuer(tokenIssuer)
			.setAudience(CTX_TOKEN_AUDIENCE)
			.setExpirationTime("5m")
			.sign(pair.privateKey)
	return {
		authMiddleware: createCtxAuthMiddleware(
			verify,
			new Set(opts?.machineClientIdAllowlist ?? []),
		),
		bearer: (token) => ({ headers: { Authorization: `Bearer ${token}` } }),
		machineToken: (clientId) =>
			sign(
				new SignJWT({ client_id: clientId, scope: "ctx:access", sub: clientId }),
				issuer,
			),
		userToken: (sub, tokenOpts) =>
			sign(new SignJWT({}).setSubject(sub), tokenOpts?.issuer ?? issuer),
		verify,
	}
}
