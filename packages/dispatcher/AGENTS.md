# Dispatcher

Use Wrangler for this Worker, as explicitly approved alongside `packages/build`. The platform owns the hostname-to-AppID mapping. Send the incoming hostname and URL pathname to its OpenAPI resolution endpoint, validate the response with Zod, and forward the original request using the native dispatch namespace binding. The AppID is the WfP Worker name. Do not add a local mapping, cache, or database connection.

`CTX_PLATFORM_URL` points to the deployed platform at `https://slate.usecontextlayer.com`; no local tunnel is required. Use `env.ts` for environment-variable validation. Forward the incoming Authorization header and existing `__Secure-ctx_viewer` cookie to platform's resolution endpoint. Platform owns identity verification and public/private viewing decisions. Dispatch on 200, redirect 401 to the existing auth `/start` with `return_to`, and forward other failures. Every path, including `/slate.json`, uses this same resolution. Strip Authorization and the viewer cookie before invoking authored code. Do not add dispatcher session verification, visibility logic, or membership checks.

## Viewer tools

After successful resolution, requests carrying a viewer cookie receive the exported `Tools` capability through Cloudflare’s native loopback exports, configured with the resolved AppID and viewer session token. Pass only that RPC stub in dynamic-dispatch `props.tools`. The entrypoint forwards calls to the platform’s existing tool-execution API using the viewer cookie; that API verifies its own authentication. User code receives neither the session token nor an AppID parameter it can change. Requests without a viewer cookie receive empty props. `cloudflare.d.ts` declares the main module for Cloudflare’s typed loopback exports.

Platform also checks the app owner’s saved Polar subscription before runtime dispatch. Exactly `/slate.json` retains viewing authorization but skips billing. Forward the incoming URL pathname, not a caller-supplied override. Subscription denial is 402 and follows the existing failure forwarding; dispatcher has no Polar SDK or subscription policy. Hosted Tools calls reach the platform’s same subscription gate separately.
