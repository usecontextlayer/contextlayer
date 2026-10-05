# Auth-forwarding Worker

This Worker connects viewers on `auth.contextlayer.xyz` to web's existing Better Auth session. Use Hono for routes/cookies and Better Auth's native one-time-token endpoints for the server-side exchange. It owns no session database, OAuth client, or signing secret. Keep configuration in `env.ts`.

The host-only HttpOnly `__Host-ctx_handoff` cookie binds the browser to its random state and app return URL. Web sends a single-use token only to the configured auth callback. The domain-wide HttpOnly `ctx-viewer-auth` cookie contains the existing Better Auth session token and expires at that session's expiry. Platform verifies viewer sessions through web; dispatcher consumes its app-resolution decision and removes authentication credentials before invoking authored code. Never pass session credentials to user-code Workers. Platform owns organization authorization and tool execution.
