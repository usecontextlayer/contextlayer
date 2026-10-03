# Dispatcher

Use Wrangler for this Worker, as explicitly approved alongside `packages/build`. The platform owns the hostname-to-AppID mapping. Resolve the incoming hostname through its OpenAPI endpoint, validate the response with Zod, and forward the original request using the native dispatch namespace binding. The AppID is the WfP Worker name. Do not add a local mapping, cache, or database connection.

`CTX_PLATFORM_URL` points to the deployed platform at `https://slate.usecontextlayer.com`; no local tunnel is required. Use `env.ts` for environment-variable validation. Viewer sign-in reuses web's Better Auth session. Resolve the viewer cookie through the issuer's `/get-session` endpoint using its bearer plugin on each request. Do not cache viewer identity or verify an independent viewer JWT. Strip the viewer cookie before invoking authored code. This establishes identity, not organization authorization. GET/HEAD `/slate.json` is public so the platform can read requirements; strip the viewer cookie on this path too. All other requests require sign-in.

## Viewer tools

For authenticated app requests, create the exported `Tools` capability through Cloudflare’s native loopback exports, configured with the resolved AppID and viewer session token. Pass only that RPC stub in dynamic-dispatch `props.tools`. The entrypoint forwards calls to the platform’s existing tool-execution API using the viewer cookie. User code receives neither the session token nor an AppID parameter it can change. Public manifest requests receive no Tools capability. `cloudflare.d.ts` declares the main module for Cloudflare’s typed loopback exports.
