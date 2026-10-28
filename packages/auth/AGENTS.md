# Auth-forwarding Worker

Follow the [domain model](../../ARCHITECTURE.md#domain-model) and [viewer sign-in boundary](../../ARCHITECTURE.md#viewer-sign-in-boundary--principles). Auth owns the handoff on the user-code domain; Better Auth owns identity and session lifecycle, and platform owns viewer verification and organization authorization. Use Hono for routes and cookies and Better Auth's native one-time-token endpoint for the server-side exchange. Do not add a session database, OAuth client, signing secret or another verification path. Keep configuration in `env.ts`.

## Handoff constraints

- Return destinations must be HTTPS on exactly one slate subdomain of `CTX_SLATES_DOMAIN`, excluding `auth`, ports and URL credentials. A caller-supplied return URL must not expand the handoff to another origin.
- Bind the random state and return URL to the browser initiating the handoff through the host-only HttpOnly `__Host-ctx_handoff` cookie. Validate callback state before exchanging the one-time token, and clear the handoff cookie after exchange.
- Keep the viewer credential in the domain-wide HttpOnly `ctx-viewer-auth` cookie, expiring with the returned Better Auth session. Cookie transport must preserve the architecture's distinction between viewer and management authority; never pass session credentials to authored Workers.
- Keep callback responses uncached and without a referrer so the handoff does not persist in caches or propagate through referrer headers.

## Deployment configuration

Use the [shared service deployment workflow](../../DEVELOPING.md#service-deployment) after its [web/auth prerequisites](../../DEVELOPING.md#viewer-auth-worker). Auth's `auth.contextlayer.xyz/*` route must be more specific than dispatcher's wildcard.

Keep `CTX_AUTH_ISSUER` pointed at web and `CTX_SLATES_DOMAIN` aligned with the hosted slate domain. Dispatcher and web must agree on `CTX_VIEWER_AUTH_URL`: web uses it as the allowed callback destination. Package configuration owns defaults. Follow [viewer-session verification](../../TESTING.md#cross-site-chrome-and-viewer-sessions) when changing the handoff, cookie behavior or callback configuration.
