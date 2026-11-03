# Dispatcher

Follow the [domain model](../../ARCHITECTURE.md#domain-model) and [hosted-slate routing contract](../../ARCHITECTURE.md#hosted-slate-routing). Platform owns hostname resolution, viewing authorization, membership and billing admission; dispatcher consumes those decisions and delegates only their authorized capabilities. New browser or MCP paths must preserve that ownership, without a local mapping, cache, database connection or second authorization policy.

Use Wrangler for this Worker and validate configuration in `env.ts`. Resolve the original hostname and pathname through platform's OpenAPI operation, validate with shared `resolvedSlateSchema`, then dispatch the original request through `SLATES` using the returned SlateID. Browser resolution forwards the incoming Authorization header and viewer cookie; MCP uses the separate bearer-only boundary below. Strip Authorization and the viewer cookie before invoking authored code. Preserve the routing contract's browser sign-in redirect and pass other failures through.

## Browser request and response policy

Mount the shared Hono `browserSecurity` middleware after MCP routes and before the browser wildcard. It must enforce the [browser isolation policy](../../ARCHITECTURE.md#hosted-slate-routing) before resolution, capability construction, authored execution or metering. Keep request admission in that middleware; do not add consumer-specific interpretations of same-site trust or navigation. Vary responses on every Fetch Metadata input used for admission: `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`.

Apply the trusted response policy to assets as well as documents. Append its CSP as an additional policy rather than replacing authored CSP, so authored restrictions remain effective. Hono owns response-header mutation; use native `Headers.getSetCookie()` to preserve separate cookie fields. Remove cookies with an empty name and every `ctx-viewer-auth` cookie regardless of Domain or Path, preserving ordinary slate cookies. Keep the policy's limits explicit: browser hardening does not establish egress isolation.

## Viewer capabilities

After resolution succeeds, construct the shared `Tools` and `Databases` capabilities through Cloudflare's native loopback exports only when the request carries a viewer cookie. Bind the resolved SlateID and typed viewer-session credential in native props, and pass the RPC stubs through dynamic-dispatch `props.tools` and `props.databases`. Requests without that cookie receive empty props. Keep `cloudflare.d.ts`'s main-module declaration so the loopback exports remain typed.

Use the shared entrypoints from `@usecontextlayer/shared/tools-worker` and `@usecontextlayer/shared/databases-worker` through platform's separate `Execution` WorkerEntrypoint and native `EXECUTION` binding. Keep the local `LocalTools` authority path in the SDK and CLI, following the [resource contract](../../ARCHITECTURE.md#slate-tool-calls-and-local-development--agreed-contract). Do not add a mode flag, optional declarations, or interchangeable credentials to the hosted entrypoints. No cookie header or public execution URL belongs in these hosted entrypoints. Authored code must receive neither the session token nor a SlateID parameter it can change.

Preserve the shared `HostedExecution` [result and refusal contract](../../ARCHITECTURE.md#platform-tool-execution) through the shared entrypoints; do not translate its errors or setup Responses into a dispatcher-specific envelope. Private first use may establish membership through platform preparation; dispatcher must not implement that policy. Keep physical database namespace access and provisioning inside platform.

Forward platform's billing decision before dispatch, including its 402 response body. Apply the decision to static and authored runtime requests without declaration-path exemptions. Keep dispatcher free of billing admission policy; Polar's SDK here reports executed usage. Hosted capability calls receive platform's billing decision separately. Keep billing authorization independent of the post-response classification that determines whether executed work generates usage.

## Slate usage

After ordinary HTTP dispatch returns, use `slateRequestUsage` and `recordSlateUsage` from `@usecontextlayer/shared/slate-usage` without copying their classification or event weights. Classification depends on authored response headers; it does not establish an unbypassable static/runtime distinction. Keep Owner attribution and weights in the trusted shared module, without SDK instrumentation or a slate reporting callback.

Schedule native Polar ingestion with `executionCtx.waitUntil` and return the slate response without awaiting delivery. Validate `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` in `env.ts`; keep those credentials and the resolved Owner out of authored code.

## MCP

Follow the [authored MCP contract](../../ARCHITECTURE.md#authored-mcp-tools-and-views). Register public metadata and exactly `/mcp` before the browser wildcard. Read metadata from platform's canonical slate metadata operation without caller credentials. For MCP resolution, forward only the explicit Authorization header with the actual hostname and `/mcp` pathname; never forward viewer or native web cookies. Platform owns credential verification, viewing and billing. Forward its OAuth challenges and failures without browser-login redirects.

After resolution succeeds, use `serveMcp` and the native MCP SDK HTTP lifecycle. Discover tools and Views from generated `/mcp.json` and static View assets through `SLATES`; never import or evaluate author modules in trusted code. Use native MCP Apps registration helpers and the shared artifact schema, without a custom JSON-RPC implementation. Artifact reads and tool execution requests must not forward caller credentials into authored code.

Invoke a named tool with `mcpTool` in native dispatch props and validated JSON arguments. Validate the native tool result, then schedule one shared `tool_call` event through `waitUntil`. Keep MCP discovery, resource reads, and tool calls outside ordinary HTTP action/loader metering. Reject MCP declarations with any connection, database, or secret requirement, matching the SDK build boundary; never substitute resources declared by the slate's app.

## Chrome

Keep profile and connection reads in platform's [chrome](../../ARCHITECTURE.md#slate-chrome). Do not add Viewer or Connections entrypoints, chrome rendering, or profile and assignment database access to dispatcher.

## Deployment configuration

Use the [shared service deployment workflow](../../DEVELOPING.md#service-deployment) and its [cross-Worker prerequisites](../../DEVELOPING.md#dispatch-worker). The `contextlayer-prod` Workers for Platforms namespace must exist before deployment. Bind `EXECUTION` to `contextlayer-platform` for deployment and `contextlayer-platform-test` for tests; keep environment selection in Wrangler configuration.

Configure proxied wildcard DNS for `*.contextlayer.xyz`. Wrangler attaches that route to `contextlayer-dispatcher`; `CTX_PLATFORM_URL` points to the deployed platform at `https://platform.usecontextlayer.com`. Hosted slate routing uses that platform and its database; it needs no local server or tunnel. Keep `CTX_VIEWER_AUTH_URL` aligned with auth and web's allowed callback destination under [Auth configuration](../auth/AGENTS.md#deployment-configuration).
