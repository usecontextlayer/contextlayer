# Dispatcher

Follow ARCHITECTURE.md's [domain model](../../ARCHITECTURE.md#domain-model) and [hosted slate routing](../../ARCHITECTURE.md#hosted-slate-routing). Use Wrangler for this Worker, as explicitly approved alongside `packages/build`. Keep hostname resolution in platform: send the incoming hostname and URL pathname to its OpenAPI resolution endpoint, validate the result with Zod, and dispatch the original request through `SLATES` using the returned SlateID. Do not add a local mapping, cache, or database connection.

Keep the deployed `*.contextlayer.xyz/*` route on dispatcher and the platform origin at `https://platform.usecontextlayer.com` in `CTX_PLATFORM_URL`. Follow [DEVELOPING.md](../../DEVELOPING.md#dispatch-worker) for local and deployed configuration. Validate environment variables in `env.ts`. Forward the incoming Authorization header and existing `ctx-viewer-auth` cookie for ordinary browser resolution. Redirect 401 to auth's `/start` with `return_to`, and forward other failures. MCP uses the explicit bearer-only boundary below. Strip Authorization and the viewer cookie before invoking authored code. Do not duplicate platform's session verification, viewing policy, or membership checks.

## Viewer capabilities

After resolution succeeds, construct the shared `Tools` and `Databases` capabilities through Cloudflare's native loopback exports only when the request carries a viewer cookie. Bind the resolved SlateID and typed viewer-session credential in native props, and pass the RPC stubs through dynamic-dispatch `props.tools` and `props.databases`. Requests without that cookie receive empty props. Keep `cloudflare.d.ts`'s main-module declaration so the loopback exports remain typed.

Use the shared entrypoints from `@usecontextlayer/shared/tools-worker` and `@usecontextlayer/shared/databases-worker`. Their hosted calls must use platform's separate `Execution` WorkerEntrypoint through `EXECUTION`, bound to `contextlayer-platform` for deployment and `contextlayer-platform-test` for tests. Keep the local `LocalTools` authority path in the SDK and CLI, following the [resource contract](../../ARCHITECTURE.md#slate-tool-calls-and-local-development--agreed-contract). Do not add a mode flag, optional declarations, or interchangeable credentials to the hosted entrypoints. No cookie header or public execution URL belongs in these hosted entrypoints. Authored code must receive neither the session token nor a SlateID parameter it can change.

Preserve the shared `HostedExecution` result contract: `forbidden` and `not-declared` become ordinary errors with those exact messages; Tools and Databases return native HTTP 409 setup Responses over RPC: `connection-required` with its slug or `secret-required` with its name. SDK adapters throw them inside the slate's app. Private first use may establish membership through platform preparation; dispatcher must not implement that policy. Preserve billing refusal messages. Keep physical database namespace access and provisioning inside platform.

Forward platform's billing decision before dispatch, including its 402 response body. Pass the actual incoming pathname so platform can apply its `/slate.json` billing exemption while retaining viewing authorization. Keep dispatcher free of billing admission policy; Polar's SDK here reports executed usage. Hosted capability calls receive platform's billing decision separately. Keep billing authorization independent of the post-response classification that determines whether executed work generates usage.

## Slate usage

Validate resolution through `resolvedSlateSchema` from `@usecontextlayer/shared/slate-usage`. After ordinary HTTP dispatch returns, use that module's `slateRequestUsage` and `recordSlateUsage` without copying their classification or event weights. Classification depends on authored response headers; it does not establish an unbypassable static/runtime distinction. Keep Owner attribution and weights in the trusted shared module, without SDK instrumentation or a slate reporting callback.

Schedule native Polar ingestion with `executionCtx.waitUntil` and return the slate response without awaiting delivery. Validate `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` in `env.ts`; keep those credentials and the resolved Owner out of authored code.

## MCP

Register public `/.well-known/oauth-protected-resource/mcp` and exactly `/mcp` before the browser wildcard. Read metadata from platform's canonical slate metadata operation without caller credentials. For MCP resolution, forward only the explicit Authorization header with the actual hostname and `/mcp` pathname; never forward viewer or native web cookies. Let platform verify the slate audience and `mcp:access` scope and apply viewing and billing policy. Forward its OAuth challenges and failures without browser-login redirects.

After resolution succeeds, use `serveMcp` and the native MCP SDK HTTP lifecycle. Discover tools and Views from generated `/mcp.json` and static View assets through `SLATES`; never import or evaluate author modules in trusted code. Use native MCP Apps registration helpers and the shared artifact schema, without a custom JSON-RPC implementation. Artifact reads and tool execution requests must not forward caller credentials into authored code.

Invoke a named tool with `mcpTool` in native dispatch props and validated JSON arguments. Validate the native tool result, then schedule one shared `tool_call` event through `waitUntil`. Keep MCP discovery, resource reads, and tool calls outside ordinary HTTP action/loader metering. Reject MCP declarations with any connection, database, or secret requirement, matching the SDK build boundary; never substitute resources declared by the slate's app.

## Chrome

Keep profile and connection reads in platform's [chrome](../../ARCHITECTURE.md#slate-chrome). Do not add Viewer or Connections entrypoints, chrome rendering, or profile and assignment database access to dispatcher.
