import type { MiddlewareHandler } from "hono"
import type { CtxTokenVerifyResult } from "@/lib/verify-ctx-token"

// The Hono variables every platform resource-server route can rely on after the
// auth middleware runs. A user request carries `sub` (the verified global web
// user id from its platform token) → the per-route membership gate runs. A
// machine request carries `machine` instead: its token's `sub` is a client ID,
// not a user ID, so it must not reach user-scoped routes as context `sub`. Exactly one
// of those two is set. `bearer` is the RAW VERIFIED token (either kind), stashed
// so a route can forward the caller's own credential on a cross-plane SDK dial
// (slate → base); it is absent under the trust-env dev middleware, which stamps
// `sub` with no token at all. Both platform planes share this context contract
// and middleware so their interpretation of one deployment's identity cannot drift.
export type AppEnv = { Variables: { sub: string; machine?: boolean; bearer?: string } }

/**
 * Global authentication middleware for a platform resource server: require a
 * Bearer platform token and verify it offline via the injected verifier. A
 * **user** token stashes its `sub` for the per-route membership gate. A
 * **machine** token is admitted only when its
 * `clientId` is in `machineClientIdAllowlist` — then it is deployment-root (`machine` set;
 * membership skipped downstream). A missing / non-Bearer / invalid token is 401;
 * a machine whose `clientId` is not allowlisted is 403; an infrastructure failure
 * (e.g. the JWKS endpoint is down) is NOT masked as 401 — the verifier throws for
 * non-token failures and we let it propagate loudly (see createCtxTokenVerifier).
 *
 * Both the verifier and the client-ID allowlist are injected so production wires the
 * remote-JWKS verifier + env allowlist while tests inject a fake or fixture-JWKS
 * one — the seam that keeps verification independent of the run-model: how a
 * caller acquires its token varies by deployment, but the verify path never
 * changes. An empty allowlist admits no machine: a verify-only RS that
 * serves only users (the slate bridge) passes one to reject every machine token.
 */
export function createCtxAuthMiddleware(
	verify: (token: string) => Promise<CtxTokenVerifyResult>,
	machineClientIdAllowlist: ReadonlySet<string>,
): MiddlewareHandler<AppEnv> {
	const BEARER_PREFIX = "Bearer "
	return async (c, next) => {
		const header = c.req.header("Authorization")
		const token = header?.startsWith(BEARER_PREFIX)
			? header.slice(BEARER_PREFIX.length)
			: undefined
		if (!token) {
			return c.json({ error: "Missing bearer token." }, 401)
		}
		const result = await verify(token)
		if (!result.ok) {
			return c.json({ error: "Invalid token." }, 401)
		}
		c.set("bearer", token)
		if (result.kind === "machine") {
			// The audience is global across web's clients, so it can't scope a
			// machine to THIS platform — the client-ID allowlist does. An
			// empty/forgotten allowlist admits no machine (fail-loud, never open).
			if (!machineClientIdAllowlist.has(result.clientId)) {
				return c.json({ error: "Machine client not allowed." }, 403)
			}
			c.set("machine", true)
		} else {
			c.set("sub", result.sub)
		}
		await next()
	}
}
