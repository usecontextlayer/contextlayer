/**
 * The client-side twin of {@link CtxTokenVerifyResult}: a caller's source of the
 * current platform bearer. Browser, bridge, and daemon callers share this contract;
 * resource servers authenticate the presented token independently.
 *
 * It yields the RAW token, without the `Bearer ` prefix, so HTTP headers and
 * WebSocket URLs can share the same source. Credential acquisition and caching
 * belong to the backing; this contract does not select an identity or grant type.
 */
export type CtxTokenProvider = () => Promise<string>

// Build the platform-client `headers` option that attaches the `aud=urn:ctx:platform` bearer.
// Client-agnostic — BaseAPIClient and SlateAPIClient share the option shape — so
// every platform-client attach site (ctxb, ctxe, the slate-bridge) spreads this
// into its constructor: `new XAPIClient({ environment, ...ctxAuthHeaders(p) })`.
// Authorization is a function-valued Supplier so the SDK re-resolves it per request
// and a refreshed token flows without rebuilding the client.
export function ctxAuthHeaders(tokenProvider: CtxTokenProvider | undefined): {
	headers?: { Authorization: () => Promise<string> }
} {
	if (!tokenProvider) {
		return {}
	}
	return { headers: { Authorization: async () => `Bearer ${await tokenProvider()}` } }
}
