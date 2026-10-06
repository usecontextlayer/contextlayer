# Platform

These instructions define the intended architecture and principles the platform should uphold. Requirements describe what must be true, not proof that every protection or feature is implemented. Keep implementation progress and temporary experiments in the planning documents.

## OpenAPI, Zod, and Shared Domain Functions

**Use OpenAPI for application APIs, Zod for validation, and one shared domain function for each operation's business logic and database calls. API handlers and server-side loaders/actions must call that same function.** Apply this shape even to a simple database query.

- **Schemas must own the contract.** Define API input and output schemas with Zod. Reuse them for validation, inferred TypeScript types, and generated OpenAPI documentation. Reuse the same input schema wherever callers accept the same untrusted input.
- **API handlers should own HTTP.** Parse and validate request inputs, call the domain function, and translate its result into an HTTP response. Keep business decisions and database queries in the shared function.
- **Loaders and actions should call the domain function directly.** React Router server loaders/actions should invoke it in-process, validate their untrusted inputs, and adapt its result to the framework's response conventions. Do not call our own API over HTTP or implement a second database path.
- **Domain functions must own the operation.** Accept typed, normalized arguments, enforce business rules, perform database reads/writes, and return typed results. Do not accept framework request/context objects or return HTTP responses.
- **Use ordinary functions grouped by domain.** One operation should have one implementation, regardless of its entry points. Do not add service classes, a generic repository layer, or a dependency-injection framework to express this boundary.

For example, `GET /api/apps` and the app-listing loader should both call `listApps(...)`. That function should own the query; the endpoint and loader should each adapt its result for their caller. OpenAPI and the shared operation should be part of the first implementation.

## UI

Use pure shadcn/ui with the `base-nova` style. Add components through the shadcn CLI and compose them with standard Tailwind layout utilities. Keep the preset's tokens and component styling; do not introduce a parallel custom visual system.

Use Fugaz One at weight 400 for the lowercase `contextlayer` wordmark through `font-logo`, matching the website. Use Geist for dashboard text. Use Font Awesome Slab Regular icons through the official React component and npm kit, with the box icon for apps. See [the shared Font Awesome configuration](../../.font-awesome.md) for imports and setup.

## App identity and storage

Platform should own the immutable `app.id` UUID and unique `app.public_hostname`, without a separate display name. The UUID should name the Artifacts repository and the `/git/<app-id>` address. Create apps during `ctx init`, not on first push. PostgreSQL must enforce exactly one of `owner_user_id` or `owner_organization_id` through `app_exactly_one_owner`. Those IDs must refer to web's Better Auth identities without duplicating their records in platform.

Normalize validated creation input and the verified caller into the canonical `Owner` union in `app/owner.ts` before writing. Creation, listing, connections, and secrets should share that ownership shape. Dashboard `OwnerDetails` should derive its variants from `Owner`, adding schema-derived organization name/slug metadata only for presentation. `POST /api/apps` must require authentication. An omitted `organization_slug` should select the verified user; a supplied slug must resolve against the caller's authoritative organization list before database or Artifacts writes. Return 404 for an unavailable organization. Callers must not choose another user as owner.

Use existing `db-infra` helpers, package-owned Kysely migrations, and Kanel-generated models. Never hand-edit generated models. Keep `verbatimModuleSyntax: false` for compatibility with Kanel's default Database type export. The server should own its database connection; migrations and Kanel generation should run through the package's Node database management commands.

Store `app.visibility` as non-null text, validate `public`/`private` through `appVisibilitySchema`, and use `DEFAULT_APP_VISIBILITY = "private"` for creation. Parse app rows through `appSchema` before returning app-bearing results. Public viewing should allow anybody; private personal viewing must require the owning user, and private organization viewing must require membership in the app's owning organization. The session's selected workspace must not determine membership. All viewing consumers should share `authorizeAppViewing`; source access and management must use the owner/member rule regardless of visibility.

## Workers runtime

Use Cloudflare Workers through `react-router-hono-server/cloudflare` and the Cloudflare Vite plugin. Use workerd for local development and Wrangler for local production verification. Validate Worker bindings in `env.ts`. Follow [README.md](README.md) for Doppler `platform/dev`; use Wrangler's native `secrets.required` to load declared environment variables instead of maintaining `.dev.vars`. Hono middleware should own each request's Postgres.js/Kysely connection, share it with API handlers and React Router loaders, and close it through `waitUntil`. Do not run migrations or Kanel generation inside the Worker.

Keep React Router's `/dashboard/` basename separate from Vite's default `/` asset base. Use selective `assets.run_worker_first` for `/api/*`, `/git/*`, and `/dashboard/*` so page/data requests and APIs reach their authorization boundaries while assets use native Cloudflare/Vite serving. Do not put assets under `/dashboard/` or run the Worker first for every path. Keep user-app dispatcher authorization separate.

Use the native `ARTIFACTS` binding directly in domain functions. Acquire disposable repository handles with `using`. Configure the namespace in Wrangler; do not add runtime Artifacts REST clients or API-token secrets.

## Platform and web ownership

Web should own users, Better Auth sessions, organizations, memberships, and identity verification. Platform should own apps and app authorization. Treat cookies and tokens as opaque credentials; never derive identity from unverified fields or introduce a second session secret, session store, or membership mirror.

For native browser requests, forward the caller's Cookie header to web's `/api/auth/get-session` for verification. Retain CLI bearer authentication through web's JWKS. Keep the verified identity and its credential together at the request boundary so loaders and domain functions use the same caller.

Web's `/api/me` should own the safe profile contract (`id`, `name`, nullable `image`) for authorized CLI tokens and native web sessions and must reject viewer cookies. Trusted consumers should call web directly; do not add a public platform profile proxy or delegate profile reads to authored code. For user-scoped web facts, forward that caller's authorized credential to the appropriate web endpoint. Web must authenticate the caller and return authoritative facts; platform should apply its app rules. Do not introduce machine-to-machine authentication for these reads.

## API authentication and authorization

Default platform API, Git, and dashboard authentication must accept only native web sessions and authorized CLI tokens. Use the existing `identifyUser` middleware and narrow optional identity with `requireAuth` at protected boundaries. Explicit bearer credentials should take precedence. Keep one identity context; do not maintain a separate user context variable.

Viewer-cookie acceptance must be explicit: only `GET /api/apps/resolve` and `POST /api/apps/:target/tools/call` may opt into `ctx-viewer-auth` through `identifyViewer`. Mount these groups before default API identity verification, and mount the API before native identity middleware for Git/dashboard. Connection reads/writes, app management, agent-source reads, secrets, Git, and dashboard must reject viewer-cookie authentication. Better Auth should verify viewer identity, but viewer credentials must not contain reusable web management credentials or be replayable as native web sessions. Keep session ownership in web and all credentials out of authored code.

Reuse one authentication middleware for `requireAuth` and `requireDashboardAuth`. Enable redirects only for dashboard GETs preferring HTML: use Hono's `accepts` helper and web's `/auth/sign-in?redirectTo=<requested-dashboard-url>`. Non-HTML dashboard requests and API/Git requests should return 401. Negotiate through `Accept`, not request `Content-Type`; unspecified or wildcard preferences should retain 401. Better Auth's existing UI and native protocols should own social callbacks and trusted-origin validation, without a custom callback protocol or session mechanism.

Native web/CLI organization reads should use `/api/platform/organizations` for `{id, slug, name}` records. Viewer-authenticated private organization viewing must instead use web's explicitly allowed `/api/viewer/organizations/:organizationId/membership` for only `{isMember}` about the canonical app's owner. Keep this HTTP boundary in `checkViewerOrganizationMembership`, selected explicitly by `resolveAppForViewing` for viewer sessions. Web must verify the session and remain the membership authority.

`resolveAppForViewing` should normalize an AppID or public-hostname target, look up the canonical app, retrieve membership facts, and call the pure `authorizeAppViewing(app, identity, isOwnerOrganizationMember)`. Keep network I/O and framework context out of the pure predicate. The resolution endpoint should return 200 with `{id, owner}`, 401 for required sign-in, 403 for denied viewing, and 404 for an absent app. Dispatcher must consume this decision for every hosted-app path without duplicating authorization policy.

`authorizeAppManagement` should own the pure owner/member rule for Git source access, app listing, visibility updates, and other management operations. Public visibility must grant viewing only. Retrieve authoritative membership facts before applying the rule; `listApps` should fetch them once for its listing. `PATCH /api/apps/{target}` should validate through `updateAppVisibilityRequestSchema`, resolve canonical `AppAccess`, and call the shared `updateAppVisibility` operation. That operation must require management before writing and return the saved app.

Git must require authentication and management before reading Artifacts or minting credentials. Share `getGitAccess` and `listApps` across their consumers. Upload-pack should receive read credentials and receive-pack write credentials, including GET discovery; HTTP method alone must not determine publication permission. Keep Artifacts credentials server-side. Organization membership should carry no additional role restriction.

## Connections and shared secrets

Connections and secrets must use the canonical `Owner`. Shared `authorizeOwner` in `owner.server.ts` must establish that a personal Owner matches the verified caller or that web confirms organization membership before provider I/O. `ownerParamsSchema` should validate HTTP `user`/`org` parameters and convert them to the canonical Owner at the boundary.

Use `secrets.schema.ts` and `secrets.server.ts` for shared-secret management. Platform alone should construct provider keys and select the vault through `CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT`, `CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG`, and the config-scoped `CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN`. Local development should select `customer-credentials-local/prod`; deployed platform should select `customer-credentials/prod`. Require vault configuration for authorized secret operations without coupling unrelated routes to it. Return only Owner/name. Never log values, request bodies, credentials, or provider responses. Manifest secret declarations should reference the selected Owner's named vault secret directly; do not add a secret-assignment table.

`GET` and `POST /api/connections/{type}/{owner_id}` should list or authorize the selected Owner's Composio Platform accounts. `listConnections` and `authorizeConnection` must receive validated configuration, verified identity, and canonical Owner and enforce management before provider calls. Filter account lists and create provider sessions using that same Owner ID. An organization member may complete OAuth, but the resulting connection must belong to the organization. Keep provider credentials and account refresh in Composio; app assignments should reference those accounts. CLI `owner.ts` should share personal/organization resolution across connection and secret commands.

`listAppConnections`, `assignAppConnection`, and `callTool` should receive canonical `AppAccess` from the shared viewing boundary and a validated manifest snapshot. `getCredentialOwner` should resolve viewer mode to the acting user and owner mode to the app's owning user or organization. Persist assignments by `(app_id, owner_type, owner_id, slug)` and read both Owners together when listing. Owner assignment must require app management; viewer assignment should follow app viewing. Authored owner-mode execution should require viewing, while credential configuration must remain management. Local manifest substitution for assignment/execution must require management.

Keep declared-requirement and assignment selection in `resolveAppConnection`, and create Composio sessions in `callTool` for the selected Owner. Platform's existing HTTP tool API must own execution, authentication, authorization, and metering. Local and hosted Tools should use one shared `WorkerEntrypoint` HTTP implementation, configured through native `ctx.props`; do not add a second execution path for either runtime.

## Manifest transport and contracts

Use `@usecontextlayer/shared/slate` for the manifest, secret names, and viewer/owner requirement schemas. Build the neutral assignment-read response in `@usecontextlayer/shared/app-connections` from that requirement schema; extend it with `appSchema` for platform OpenAPI and reuse it in the CLI. Keep database-specific assignment input branding in `app/app-connections.schema.ts`. `listAppConnections` should own requirement/assignment reads, with the trusted chrome loader invoking it directly. Authored SDK/runtime code must expose neither profile nor connection-read capabilities.

Platform must authorize viewing before reading a deployed manifest through its native APPS dispatch binding by canonical AppID. `getAppManifest` should receive an App, the binding, and optionally a boundary-validated local manifest; it must not receive caller credentials. Build a fresh credential-free `/slate.json` request, follow no redirects, and supply no runtime-capability props. Return canonical Slate with local/deployed provenance as `ManifestSnapshot`. Connection and tool operations should consume that snapshot instead of fetching authored content themselves; retain management checks for local substitutions. Hosted execution and agent-run preparation should use the deployed reader. Local Tools should receive the CLI-validated checkout manifest through native service-binding props.

## Agent source and preparation

Use `agents/<name>/instructions.md` in the app's Artifacts repository for agent definitions. `getAgent` must require source-management permission through `AppAccess` before reading, including for public apps. Pin the read to the selected `main` commit and return the instructions with that hash. Expose inspection through `GET /api/apps/{target}/agents/{name}` with Zod/OpenAPI. Viewing permission alone must not grant source inspection.

Keep `getAgentRun` as an internal preparation operation with `AppAccess` from an authenticated viewing boundary. Reuse the pinned source reader and deployed `getAppManifest` without applying source-inspection management permission to execution. Pure `prepareAgentRun` should combine those inputs with the task and resolve declared secret names through `getCredentialOwner`. `agentRunSchema` should contain app/acting-user IDs, published instructions and revision, the separate prompt, and canonical Owner references, without caller credentials or secret values.

## Dashboard workspace selection

Use web's native Better Auth organization API for browser choices and authenticated `/api/platform/organizations` records for server-side slug resolution and membership. Use `/dashboard/personal/apps` for Personal and `/dashboard/org/<slug>/apps` for organizations. The URL should select the workspace; do not mutate Better Auth's active organization. Return explicit `OwnerDetails` with the verified user for Personal or the verified organization's stable ID, name, and slug.

After Better Auth confirms account switching, navigate to `/personal/apps` with history replacement and load the new user's apps. Omit `/dashboard` from React Router links because the basename supplies it. Share app listing between the loader and OpenAPI. Validate optional `owner_user_id`/`owner_organization_id` filters with Zod and normalize to `Owner`; omit both for all manageable apps and reject supplying both. Selecting a workspace must narrow an already-authorized listing, never grant access.

## App-owner subscription access

Use Polar's native SDK to verify raw `customer.state_changed` requests at `POST /api/polar/webhooks` with `POLAR_WEBHOOK_SECRET`. Acknowledge only after `saveCustomerState` persists the full native Customer State. Use package migrations and Kanel for the schema. Treat `external_id` as the Better Auth user/organization ID and Polar's `organization_id` as our merchant, never the app's owning team.

Keep subscription access separate from identity and viewing authorization. `requireAppSubscription` should call shared `checkAppSubscription` after viewing authorization on hostname resolution and runtime tool calls. Require a nonempty owner `active_subscriptions` array; Free qualifies, while missing/empty state should return 402. Resolution should receive the actual incoming `pathname`; exactly `/slate.json` should skip billing while retaining viewing authorization. Connection configuration, app creation/listing, Git, dashboard, and billing management should remain available. Hosted and local Tools must converge on the same gated endpoint. Seed owners through native Customer State before enabling enforcement; request-time checks should read Postgres without a Polar API fallback.

## App usage

Keep the canonical owner schema, resolution contract, and Polar event weights in `@usecontextlayer/shared/app-usage`. Platform's `app/owner.ts` should re-export `Owner`, keep `OwnerDetails` for dashboard presentation, and use `getAppOwner` to convert canonical apps. Return that owner to dispatcher after authorization.

After `callTool` returns an execution result, its HTTP handler should schedule `recordAppUsage` for one `tool_call` clip through native `executionCtx.waitUntil`. Missing assignments and authorization denials must not generate usage. Returned Composio execution errors should still count as executed calls. Use the app owner as Polar's `external_customer_id`, not the viewer. Validate `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` in `env.ts`; preserve background task failures instead of catching and discarding them.

## Embedded chrome

Keep SDK Layout as the mounting point for a separate trusted document. Serve the header and inline tray through platform's existing React Router build at `/dashboard/chrome/apps/:target`; keep UI, styles, and fonts there. The frame must use a trusted `usecontextlayer.com` origin permitted by the architecture. Private app entry must automatically authenticate the header as the same viewer without an additional popup sign-in step. Let Better Auth own identity verification and revocation; web logout must invalidate frame authentication. Authenticate the frame through the existing native web session middleware. Native session cookies must use Secure, HttpOnly, and SameSite=None in every environment; browser third-party-cookie policy still applies. The session flow must not expose credentials to authored code.

Chrome must validate inputs at its request boundary and use the same authorized domain operations as other trusted consumers. Web should remain the profile authority. Connection reads and writes should share canonical app, manifest, and credential Owner relationships, with Owner authorization before provider I/O. Account catalogs must remain inside the trusted frame and must not be exposed to viewers who cannot manage that Owner. Keep labels as live presentation data and let native framework loaders/actions own mutations and revalidation, without a parallel client-side assignment store. Chrome data must not pass through authored loaders, Workers, or either clips metering path.

Parent/frame messages must validate origin, source window, and payload and carry only presentation information such as height. Never send authentication, profile, or connection data to the authored parent or expose an authenticated API relay. Protect session-changing actions at the trusted request boundary and use native authentication protocols rather than inventing another session store.

Treat React Router's `/dashboard/__manifest` as public route metadata like assets. Public discovery must not grant access to protected loaders or APIs. Apply CSP `frame-ancestors` to restrict chrome embedding to intended HTTPS app subdomains of `CTX_APPS_DOMAIN`; permit local preview origins only for local previews. Forbid object embeds and base-URL changes and restrict frame form submissions to its own origin. Protect cookie-authenticated form mutations with Hono's native CSRF middleware and retain Better Auth's origin checks. CSP controls embedding and must not be treated as a way to override browser cookie policy. Do not grant authored origins credentialed CORS access.
