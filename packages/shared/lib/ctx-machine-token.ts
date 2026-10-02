import { z } from "zod"
import { CTX_TOKEN_AUDIENCE } from "@/lib/ctx-token-audience"
import type { CtxTokenProvider } from "@/lib/ctx-token-provider"

// The machine `client_credentials` backing for the ctx-token provider seam.
// Mints an `aud=urn:ctx:platform` machine JWT against web's OAuth2 token endpoint and caches
// it in-memory until just before expiry — the grant issues no refresh token, so
// re-minting with the secret IS the loop. ONE audited copy, shared by ctxb + ctxe — this module
// imports only the `CtxTokenProvider` TYPE (erased) and the import-free
// `CTX_TOKEN_AUDIENCE` leaf, so it pulls in neither
// `hono` nor `jose`; it is exported from a dedicated package subpath
// (`@usecontextlayer/shared/ctx-machine-token`) that bypasses the package barrel
// for exactly that reason. The provider is host-side only: the secret and the
// minted token never enter the synthesis guest — a prompt-injected synthesizer
// could exfiltrate them and escalate from one workspace's secrets to
// deployment-root.
//
// Scope: the platform-managed machine identity only. resolveMachineTokenProvider
// owns credential selection for both CLIs; this module has no user-token backing.

// Re-mint this many ms before the token's stated expiry so a request never rides
// a token that lapses in flight (clock skew + the round-trip to the RS). The
// machine token's TTL is ~1h, so a minute of headroom costs nothing. Assumes
// TTL >> skew: a token whose `expires_in` is <= 60s would be stale on arrival and
// re-mint on every call (loud — a mint storm, never a silently-stale token).
const EXPIRY_SKEW_MS = 60_000

export type MachineTokenProviderConfig = {
	// The full token endpoint, e.g. `${CTX_WEB_URL}/api/auth/oauth2/token`.
	tokenUrl: string
	// The confidential machine client; it must be admitted by the target platform's
	// client-ID allowlist before the minted token can access that deployment.
	clientId: string
	clientSecret: string
	// Injected in tests to capture the request / stub the response; defaults to
	// the global `fetch`.
	fetchImpl?: typeof fetch
}

// The standard OAuth2 token response we depend on. Parsed strictly so a malformed
// or opaque (non-`expires_in`) response fails loud at the mint, not later as a
// silently-stale token.
const tokenResponseSchema = z.object({
	access_token: z.string().trim().min(1),
	expires_in: z.number().positive(),
})

// Build the platform machine-token provider. The returned nullary async fn is
// the `CtxTokenProvider` the CLIs attach as the bearer Supplier: it returns the
// cached token while it is fresh, otherwise mints a new one (single-flight, so a
// burst of SDK calls triggers exactly one mint).
export function createMachineTokenProvider(
	config: MachineTokenProviderConfig,
): CtxTokenProvider {
	const fetchImpl = config.fetchImpl ?? fetch
	const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
		"base64",
	)

	let cached: { token: string; expiresAtMs: number } | null = null
	let inFlight: Promise<string> | null = null

	async function mint(): Promise<string> {
		const response = await fetchImpl(config.tokenUrl, {
			body: new URLSearchParams({
				grant_type: "client_credentials",
				// Without a resource, the mint does not produce the JWT the platform
				// verifier requires. Omit scope deliberately: the issuer owns the
				// client's resource-scoped machine grant.
				resource: CTX_TOKEN_AUDIENCE,
			}),
			headers: {
				authorization: `Basic ${basicAuth}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		})

		if (!response.ok) {
			const detail = await response.text().catch(() => "")
			throw new Error(
				`Failed to mint the ctx machine token: ${response.status} ${response.statusText}${
					detail ? ` — ${detail}` : ""
				}`,
			)
		}

		const parsed = tokenResponseSchema.parse(await response.json())
		cached = {
			expiresAtMs: Date.now() + parsed.expires_in * 1000,
			token: parsed.access_token,
		}
		return parsed.access_token
	}

	return async () => {
		if (cached && Date.now() < cached.expiresAtMs - EXPIRY_SKEW_MS) {
			return cached.token
		}
		if (!inFlight) {
			// Clear on settle (success OR failure) so a failed mint is retried on
			// the next call rather than caching a rejection.
			inFlight = mint().finally(() => {
				inFlight = null
			})
		}
		return inFlight
	}
}

// The env slice the machine backing reads. The real ctxb/ctxe `env` singletons
// satisfy this structurally; the narrow attach-site slices (base-cli's BaseDsnEnv /
// BindingsPlatformEnv) are assignable because every field is optional — so the
// attach sites thread nothing new (the values ride in on the full `env` at runtime).
export type MachineTokenEnv = {
	CTX_WEB_URL?: string | undefined
	CTX_MACHINE_CLIENT_ID?: string | undefined
	CTX_MACHINE_CLIENT_SECRET?: string | undefined
}

// Select the platform-managed machine backing (scenario 1). Presence of the
// machine creds is the switch (the same pattern as the RS's `CTX_AUTH_SUB_ID`):
// both present + a web origin -> a `client_credentials` provider; neither present
// -> undefined (no bearer; local-dev authorizes via the `CTX_AUTH_SUB_ID` RS
// bypass, which needs no token). Partial creds are a deployment mistake, not a
// half-on mode -> fail loud. Shared by ctxb + ctxe so the presence-switch and the
// partial-config guard have ONE audited copy.
export function resolveMachineTokenProvider(
	env: MachineTokenEnv,
): CtxTokenProvider | undefined {
	const clientId = env.CTX_MACHINE_CLIENT_ID
	const clientSecret = env.CTX_MACHINE_CLIENT_SECRET

	if (!clientId && !clientSecret) {
		return undefined
	}

	if (!clientId || !clientSecret || !env.CTX_WEB_URL) {
		throw new Error(
			"Incomplete machine-auth config: set CTX_MACHINE_CLIENT_ID, " +
				"CTX_MACHINE_CLIENT_SECRET, and CTX_WEB_URL together (or none).",
		)
	}

	return createMachineTokenProvider({
		clientId,
		clientSecret,
		tokenUrl: `${env.CTX_WEB_URL}/api/auth/oauth2/token`,
	})
}
