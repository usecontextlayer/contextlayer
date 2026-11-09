# Platform

Preserve conceptual integrity when extending platform: use the [canonical domain model](../../ARCHITECTURE.md#domain-model), keep one owner for each decision, and make new consumers use the same operations and contracts. A new route, UI, or execution path must not introduce its own meaning of Owner, membership, resource configuration, or agent execution identity. These rules constrain future changes; they do not claim every requirement is implemented. [Documentation guidance](../../AGENTS.md#documentation) assigns architectural contracts, workflows, testing, and implementation history to their owning documents.

## OpenAPI, Zod, and Shared Domain Functions

**Expose product operations through OpenAPI and one shared domain function, including simple database queries.** API handlers and React Router server loaders/actions must call that same function. Add the API contract with the first implementation, not after the UI ships.

- Zod schemas own input validation, inferred types, and OpenAPI contracts. Reuse the input schema wherever callers accept the same untrusted input.
- Give each published operation a unique, stable `operationId` and describe non-obvious authorization and response semantics in its OpenAPI contract. The [CLI consumes these definitions directly](../../ARCHITECTURE.md#multiple-consumers).
- Handlers own HTTP: parse and validate inputs, call the operation, and adapt its result. Loaders/actions call the operation in-process; never call our own API over HTTP or implement another database path.
- Domain functions own business rules, authorization, and database reads/writes. Accept typed, normalized arguments and explicit dependencies; do not accept framework request/context objects or return HTTP responses.
- Use ordinary functions grouped by domain. Do not add service classes, a generic repository layer, or a dependency-injection framework to express this boundary.

Keep endpoint paths, payload fields, status codes, and validation rules in the schemas and route definitions that enforce them. Document non-obvious field semantics at the schema; do not maintain a second API reference here.

## UI

Use pure shadcn/ui with the `base-nova` style. Add components through the shadcn CLI and compose them with standard Tailwind layout utilities. Keep the preset's tokens and component styling; do not introduce a parallel custom visual system.

Use Fugaz One at weight 400 for the lowercase `contextlayer` wordmark through `font-logo`, matching the website. Use Outfit for dashboard text. Use Font Awesome Slab Regular icons through the official React component and npm kit, with the box icon for slates. See [the shared Font Awesome configuration](../../.font-awesome.md) for imports and setup.

## Slate identity and storage

Follow [platform storage and request flow](../../ARCHITECTURE.md#platform-storage-and-request-flow) for slate identity, creation, and visibility. Normalize validated creation input and the verified caller into the shared canonical `Owner`, re-exported by `app/owner.ts`, before writing. Creation, listing, accounts, assignments, and secrets must use that same union. Derive dashboard `OwnerDetails` variants from `Owner`, adding schema-derived presentation metadata rather than maintaining another ownership model.

Use `db-infra` helpers, package-owned Kysely migrations, and Kanel-generated models. Never hand-edit generated models. Keep `verbatimModuleSyntax: false` for compatibility with Kanel's default Database type export. Run migrations and model generation through the package's Node database commands, outside the Worker; follow [platform database migrations](../../DEVELOPING.md#platform-database-migrations) for the selected database. Parse database slate rows through `slateSchema` at the boundary before returning them to consumers.

## Slate membership

Follow [slate membership and unattended execution](../../ARCHITECTURE.md#slate-membership-and-unattended-execution) for eligibility and provisioning semantics. `addSlateMember` must be the sole membership insertion owner. Slate connection assignment, slate-aware secret supply, and first use requiring viewer resources must attempt membership through this operation. Keep the trigger in the shared domain operation so API and chrome consumers cannot diverge. An incomplete setup must not turn an otherwise valid assignment or secret save into a failure.

Reuse the pure resource-configuration resolver for whole-slate membership completeness and selected-resource request completeness. Execution admission must call `addSlateMember` before executing viewer-mode work for a private user; read-only configuration assembly and runtime construction must not insert membership. Resolve only the request's selected resources. Owner-only requests must neither create membership nor depend on unrelated personal setup. Public users and app actors must be refused viewer-mode resources independently of any stored membership.

Keep insertion and initial provisioning in `addSlateMember`: only the request that inserts the unique relationship starts provisioning, using the prepared snapshot. Existing membership must return before setup reads and must not reinstall schedules. Commit membership before awaiting Workflow creation; do not hold a database transaction across provisioning or wait for background execution. Membership is not an authorization grant, an agent submission, or a provisioning-readiness flag.

## Workers runtime

Use Cloudflare Workers through `react-router-hono-server/cloudflare` and the Cloudflare Vite plugin. Validate bindings in `env.ts` at the capability that uses them. HTTP middleware retains full `parsePlatformEnv` validation; Durable Object reconstruction uses `parseDatabaseEnv` for database access, and vault operations use `parseSharedSecretsEnv` when they need the vault. Do not require HTTP OAuth-provisioning or billing configuration merely to reconstruct an agent or install its schedules. Pass domain functions only the native bindings they use; retain parsed settings for consumers of those settings. Framework contexts may carry individual dependencies for loaders/actions. Hono middleware owns the request's Postgres.js/Kysely connection, shares it with handlers and loaders, and closes it through `waitUntil`.

Keep React Router's `/dashboard/` basename separate from Vite's `/` asset base. Putting Vite modules under `/dashboard/` sends them through the dashboard authentication/routing gate. Use selective `assets.run_worker_first` so API, Git, and dashboard page/data requests reach their authorization boundaries while assets use native serving. Do not put assets under the dashboard basename or run the Worker first for every asset. Hosted-slate authorization belongs to dispatcher’s separate boundary.

Use native `ARTIFACTS` repository handles with `using` and the private `DATABASES` namespace for slate storage. Do not add runtime storage REST clients or API-token secrets. Keep environment selection in Wrangler configuration. Follow [DevEnv](../../DEVELOPING.md#devenv) for local startup and [TESTING.md](../../TESTING.md#fixtures-and-resource-ownership) for test bindings; local development and integrations must use resources isolated from production.

Use the [shared Worker deployment workflow](../../DEVELOPING.md#service-deployment).

### Local runtime

Use [DevEnv](../../DEVELOPING.md#devenv) for ordinary development with web, auth, dispatcher and Build. Standalone Platform development uses `dev:watch`, which starts Cloudflare Vite from source with the native `test` environment. Both paths use normal Vite development mode and keep the production timer behavior. The integration-only `build:test` command produces the test build, using Vite mode `test` and writing `build-test/`; ordinary builds write `build/`. Run package tasks through the root [Turbo convention](../../DEVELOPING.md#workspace-commands). Platform runs in workerd and defaults to port 3010 when started separately. There is no Node production server or `CTX_PLATFORM_PORT` setting.

Vite preview follows the latest generated build through `.wrangler/deploy/config.json`, including `build-test/` after a test build. Preview uses the bindings selected at build time; changing `CLOUDFLARE_ENV` only at preview startup does not select another namespace. The default `ARTIFACTS` and `SLATES` bindings select `contextlayer-prod`, so select the native `test` environment before building for local verification. Wrangler's `secrets.required` imports process configuration into Worker bindings.

## Platform and web ownership

Follow [platform and web ownership](../../ARCHITECTURE.md#platform-and-web-ownership-and-dataflow). Preserve the verified identity and its opaque credential together across request and domain boundaries. Use web's authoritative profile and organization operations with that caller's authorized credential; do not add platform profile proxies, machine-to-machine substitutes for user-scoped reads, session stores, or membership mirrors. Profile reads belong in trusted consumers, never authored code.

## API authentication and authorization

Use `identifyUser` and the shared required-auth middleware for API, Git, and dashboard entry points. Explicit bearer credentials take precedence. Keep one typed identity context; do not split user data from credential authority or promote a viewer identity because its user ID matches an Owner. Dashboard sign-in responses must reuse native web authentication and Hono content negotiation, with redirects restricted to HTML-preferring GETs. Other requests retain the authentication failure response.

Keep native management authentication, browser viewer resolution, and bearer-only MCP resolution as explicit route boundaries under the [viewer sign-in](../../ARCHITECTURE.md#viewer-sign-in-boundary--principles) and [MCP contracts](../../ARCHITECTURE.md#authored-mcp-tools-and-views). Mount resolution before default API identity verification and the API before Git/dashboard identity middleware. Validate resolution input once through OpenAPI and pass it to `getSlateViewerIdentity`; forward native OAuth challenges. Resource metadata describes authority and grants no runtime access.

Hosted tool calls and SQL enter through the separate `Execution` WorkerEntrypoint over the native service binding. Validate the canonical slate and call there, verify the viewer credential, then reuse the shared authorization, billing, and domain operations. Keep `Execution` separate from `Provisioning`: the callers exercise different authority. Authored loaders/actions cannot enforce the authority of a capability also reachable outside those loaders/actions.

Keep viewing and management policy in the pure `authorizeSlateViewing` and `authorizeSlateManagement` predicates. `resolveSlateForViewing` owns canonical lookup and membership I/O; select `checkViewerOrganizationMembership` explicitly for viewer credentials. Keep network I/O and framework context out of the predicates. Other consumers, including dispatcher, must use the resulting decision rather than copy the policy. Public visibility grants viewing only; use management authorization for source access and mutation.

Git must authorize management before accessing Artifacts or minting credentials. Share `getGitAccess` and `listSlates` across consumers. Derive credential permission from the Git service: upload-pack reads and receive-pack writes, including discovery requests. HTTP method alone does not identify a write. Keep repository credentials server-side.

## Accounts, connection assignments, and shared secrets

Use canonical `Owner` and shared `authorizeOwner` before provider I/O. Convert HTTP Owner parameters through `ownerParamsSchema` at the boundary. Account discovery and connection must scope provider requests to that authorized Owner; the person completing an organization's OAuth flow must not become the connected account's Owner. Shared account schemas represent eligible active accounts so consumers do not each interpret provider lifecycle states.

Use `secrets.server.ts` for Owner-scoped vault access, key construction, and key recognition. Share the canonical Owner schema and key-prefix builder. Require vault configuration only for operations that need it; do not couple unrelated routes to the vault. Secret management returns identity/presence metadata, never stored values. Keep values, request bodies, credentials, and provider responses out of logs. Follow [Owner vault configuration](#owner-vault-configuration) for setup and [secret-vault verification](../../TESTING.md#secret-vault-writes) for testing.

`setSlateSecret` selects the declared secret's Owner from the coherent pushed snapshot and delegates authorization and persistence to `setSharedSecret`. Keep Owner-scoped set/drop independent of slate enrollment. Declared secrets reference the selected Owner's named vault secret directly; do not add a secret-assignment table or a slate-specific vault.

Keep assignment persistence in `slate-connections.server.ts` and configuration assembly in `slate-resource-configuration.server.ts`. Resolve declared requirements, credential Owner, and saved assignment through shared `resolveSlateConnection`; execution consumers must not independently resolve them. Owner-mode assignment requires slate management; viewer-mode assignment follows viewing authorization. Configuration remains available before membership. Pass the selected snapshot into membership provisioning rather than reading a new one after saving.

Use `createAccountSession` for scoped Composio execution: it owns account/toolkit pinning, the native `direct_tools` preset, disabled connection management, and enabled Composio sandbox. Callers supply authorized account data, not policy overrides. Personal-account discovery/execution derives the personal Owner from verified native identity and must exclude viewer credentials in its domain type. A supplied account ID selects within that authority; slate management and billing remain separate requirements. Keep personal-account execution and hosted slug-based delegation distinct, sharing only the scoped provider primitives.

Preserve the shared `HostedExecution` and Tools/Databases result contracts. Undeclared resources, forbidden actors, and declared-but-unassigned connections are different outcomes. Missing assignments must stop before provider execution and usage recording. The shared `connection-required` response must reach the app's React Router boundary without exposing account catalogs or credentials; never reinterpret arbitrary failures as missing setup.

### Owner vault configuration

Platform's Doppler configuration selects the hosted Owner vault:

| Platform configuration | `CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT` | `CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG` |
| --- | --- | --- |
| `platform/dev` | `customer-credentials-local` | `prod` |
| `platform/prod` | `customer-credentials` | `prod` |

Each configuration supplies `CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN` as a read/write service token scoped to its corresponding vault config. Platform declares these runtime secrets; dispatcher does not. Provisioning or changing Doppler tokens, configs or secrets remains user-owned. Keep the development and production vaults separate.

Follow the [vault access contract](../../ARCHITECTURE.md#owner-owned-shared-secrets) for configuration requirements and [secret-vault verification](../../TESTING.md#secret-vault-writes) for test prerequisites and per-write authorization.

## Declaration sources and contracts

Use the declaration schema, `collectSlateResources`, and `resourcesForConsumer` from `@usecontextlayer/shared/declaration`. Follow [the resource contract](../../ARCHITECTURE.md#key-contract-slate-resource-requirements); do not duplicate collection, validation, or consumer selection. Read app requirements from `app/slate.json` only when `app/` exists, and require a valid declaration when it does. Do not interpret absent app source as a missing declaration or read `public/slate.json` as authority.

`readSlateDeclarations` owns hosted source reads and accepts an explicit immutable commit. Latest-state operations use `readLatestSlateDeclarations` to select `main` once; builds supply their triggering commit. Carry that snapshot, including discovered agent trees, through every phase. Authorize before reading. The reader accepts no caller credentials, resolves no resource values, and invokes no authored Worker. Preserve the typed `no-commit` outcome as setup data; an uncommitted repository is not a committed empty declaration. Never accept caller-supplied declarations or Resources as hosted authority, including from slate Owners.

Derive shared resource-configuration contracts from Resources, with connection-specific projections from that same contract. Inventory, chrome, request preparation, and membership must share canonical Owners, saved references, and the same `supplied` presence field. Keep connection database-column branding at the platform input boundary. A connection-only projection must not trigger unrelated secret reads.

Inventory is metadata-only: it must not load secret values, provision databases, or claim database readiness. Derive database instance references centrally through `prepareSlateDatabaseConfiguration` and reuse them in configuration and provisioning. Declarations select resources; consumers must not supply physical instance selectors. Use the complete collection for inventory and membership, and the pure consumer selector for app/agent execution. Keep local inputs at the [local tooling boundary](../../ARCHITECTURE.md#local-tools); do not add local overrides to hosted resolution.

## Agent source and preparation

Use `getAgent` for source inspection under slate-management authorization, including public slates. Execution uses viewing authorization; do not require source-inspection permission merely to run an agent. Follow [authored agents](../../ARCHITECTURE.md#authored-agents) for the distinction.

Keep one shared path for source and resource assembly used by API operations, scheduled work, and harness construction. Boundaries supply a canonical slate, trusted `AgentActor`, and agent name; submitted input remains separate. Schedules and runtime callbacks obtain their actor from the SlateAgent identity, not reconstructed HTTP authentication. Prepare the named agent's instructions and resources from one latest coherent snapshot per preparation operation. Keep read-only configuration assembly separate from execution admission's membership action. A scheduled firing must not reuse the commit that installed its schedule.

Pure `prepareAgentConfiguration` consumes resolved configuration and returns the complete value. Do not construct a partial value and mutate it later or keep one mutable run or prompt on the shared host. Configuration carries canonical resource references, actor, instructions, and source revision for that operation; do not persist it as a conversation's authority. Exclude caller credentials, repository tokens, and secret values. Keep triggering input as native Pi user input.

Register every instruction source through Pi instruction-section renderers, including static text. Refresh current authored configuration at harness opening and before accepting new submitted input, following the [configuration-lifetime contract](../../ARCHITECTURE.md#authored-agents). Construct instruction text, resource descriptions, tools, and provider configuration from that preparation, and publish through native `registry.install()` replacement and `Models.setProvider()`. Renderers use prepared text; resource tools capture their resolved references; provider authentication captures secret Owners while loading actual API-key values when needed. Do not repeat preparation in those callbacks or add a configuration cache, persisted authority snapshot, or reload framework. Database tools use `SlateDatabase.query`, with input/output declarations derived from shared database schemas.

### Hosted agent runtime

Implement SlateAgent as a plain Cloudflare `DurableObject` with explicit `Lifecycle`, `PiHarness`, and native `Scheduler` composition. Follow the architecture's [actor and instance model](../../ARCHITECTURE.md#owners-run-actors-and-membership): one existing slate/agent/actor identity owns one harness and its many conversations. Use `getAgentInstanceName` for addressing and the Durable Object's name for runtime identity rather than persisting another identity record. Do not use `RoutedAgents` or a separate `SlateAgentJob` to host conversations. Add only capabilities required by the supported operations, and prefer Pi-native semantics over a conflicting application or framework pattern.

Keep the native root and task-owned child conversations in directory reads. Do not infer work admission from directory presence or add a separate catalog; follow the architecture's [conversation discovery contract](../../ARCHITECTURE.md#authored-agents) for their meaning.

Create conversations through `PiHarness.sessions.create()` and admit input through the selected PiHarness session so native Cloudflare wakeups and recovery remain connected to Pi execution. Resolve the adapter receipt through Pi's native submission lookup and return the real submission record; its request key is not the submission ID. Reuse native reads, scans, and conversation observations instead of maintaining an execution catalog or forwarding to a second execution host. Acquire and release one-time observations through their native lifecycle; releasing an observation must not stop accepted work.

Attach one native Cloudflare Linux container to each SlateAgent and use Pi's `CodingTools` with `RemoteExecutionEnv`. Direct and Code Mode calls, including calls from different conversations, share that computer. Keep filesystem and shell semantics in Pi. Disable computer internet access; declared external integrations run in the trusted Worker. Observe native harness idle for connection cleanup rather than polling submission results. Follow the architecture's [separate execution and data lifetimes](../../ARCHITECTURE.md#authored-agents); do not infer scratch-file restoration from durable history or create a fresh computer per conversation.

Install native `createCodemodeExtension` and `createInlineCodemodeSandbox` in the shared harness registry. Reuse registered tools and native discovery; do not create another tool catalog or a standalone search tool. Construct a ready registry in the asynchronous PiHarness factory before recovery, and use the same installation route before API and scheduled input. Preserve the architecture's shared-definition and in-flight-call lifetimes rather than adding per-conversation configuration. The sandbox receives registered capabilities, never ambient Worker bindings, network, or filesystem access. Let native durable execution own deadlines, replay, and individual VM disposal. Register sandbox and computer cleanup with the SlateAgent's Lifecycle. Use the Cloudflare package's compiled WASM through the existing build, without another Worker or binding.

Build connection tools from authorized references through `createAccountSession`. Preserve native action schemas, namespace/deferred registration, and structured results. Select matching provider sessions during refresh and let installed actions execute through their captured session. Reuse and persist native Composio session IDs within the SlateAgent by canonical Owner, toolkit, and account; changed assignments select different matching sessions instead of rebinding existing ones. Obtain schemas and execute actions through scoped sessions, and derive result declarations from Composio's exported schemas and resolver. Do not maintain an application-owned response envelope or replace session responses with catalog wrappers. Keep credentials in trusted execution, loading literal vault values without interpolation. Loader/action Tools retain their own authority and billing.

### Agent conversation and inspection API

Keep hosted agent Hono routes, wire schemas, and shared conversation/submission/schedule operations in platform. Platform owns the runtime, hosted lookup, source/resource preparation, authorization, and scope selection. Expose the six [native conversation operations](../../ARCHITECTURE.md#authored-agents), with explicit creation and submission to an existing conversation. Do not add implicit fresh/resume policy, a Job aggregate, caller-facing stop/delete operations, or a separate blocking result endpoint. Pi owns IDs, records, statuses, query filters, and cursors; completed answers are read by their native entry ID.

Preserve the existing management authentication and private-slate authorization boundary for the six conversation/submission operations. Require the schema's actor path parameter for those operations and both schedule reads. Create and submit accept only the authenticated caller's user SlateAgent; reads select either that user instance or the named agent's app instance before applying native queries. Keep authored-definition parameters independent of instance parameters. Do not accept arbitrary user IDs, supply an actor default, merge or search app and user stores, or expose physical Durable Object addresses. Apply viewing authorization to creation, submission, conversation discovery, and submission outcomes; apply source-management authorization to raw views, entries, and schedules. Schedule inspection remains available for public slates and must not inherit the Pi routes' private-slate rejection or native paging-error mapping. The [architecture](../../ARCHITECTURE.md#authored-agents) owns the distinct authorization required by these payloads and credentials.

Pass trusted typed RPC results through; do not reparse them into application-owned copies. Validate unknown envelopes and generic schedule payloads at the shared domain boundary, preserving the existing JSON validators and native fields instead of reconstructing Pi's state machine. Type opacity must not disable runtime validation. Keep native record identity and envelope fields typed, and retain upstream extensions rather than stripping them. Schemas own field semantics, including inclusive entry bounds, native timestamp units, and the distinction between a current view and paged history.

### Agent schedule provisioning

Parse authored schedule frontmatter with the standard YAML parser and validate its shape through `agentScheduleSchema`; let the native `Scheduler` validate cron syntax, interpreted in UTC, and use the Markdown body as the prompt. Preserve the authored delimiter/body format. Git remains the authoring authority. Compose native `Scheduler` with the SlateAgent's Lifecycle so scheduling and Durable Object alarms own timing and recurrence; do not introduce a schedule configuration store or custom scheduler.

`prepareSlateProvisioning` must remain pure. Build and membership supply their selected snapshot and actors; preparation derives one `SlateProvisioning` value with deduplicated database targets. Migration and schedule phases consume it without selecting another revision or actor set. Read schedule files through the snapshot's discovered agent trees. Follow [the migration lifecycle](../../ARCHITECTURE.md#slate-databases-and-authored-migrations) and delegate migration execution to Build's [shared migration step](../build/AGENTS.md).

Derive unattended scope from each agent's own selected resources: any viewer requirement selects member scope; none selects app scope. Provision authored schedules only on supplied actors in that scope and cancel authored schedules on supplied actors outside it. Replace only authored `runScheduled` callbacks, preserving framework-owned lifecycle work. Each firing uses its stored actor's SlateAgent, creates a fresh conversation, and submits the stored prompt through current preparation and the common native submission path. Attach the authored schedule name and native schedule ID as a native custom entry. A missing agent definition cancels that instance's authored schedules; missing assignments and transient failures must not cancel them. Removing a schedule must leave its conversations available.

### Hosted model configuration

Select a hosted model by declaring `ANTHROPIC_MODEL` as an owner- or viewer-mode secret in the agent's declaration and saving a supported full Anthropic model ID through the ordinary Owner-scoped secret command. Declare provider access separately through `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Follow [model ownership](../../ARCHITECTURE.md#authored-agents): only an undeclared model uses the code's default; a declared value is required. New API and scheduled conversations read current defaults, while existing conversations retain their selected model unless explicitly reconfigured through native operations.

### Hosted subscription access

Select provider access from current declared secrets: `ANTHROPIC_API_KEY` takes precedence; otherwise use `CLAUDE_CODE_OAUTH_TOKEN`. Never switch providers after authentication or provider failure. Resolve provider credentials independently of `ANTHROPIC_MODEL` through the same resource preparation.

Use the native Anthropic provider's catalog and streaming protocol, routing subscription fetches through the private `Meridian` service. Profile identity derives from the canonical vault key; the native provider `sessionId` supplies conversation affinity. Do not substitute the shared SlateAgent identity or a new application ID for that session ID. Keep subscription tokens out of persisted conversation configuration and the computer. Meridian's SDK session files are ephemeral; Pi owns the durable conversation. Composio sessions remain a separate provider integration with the SlateAgent-scoped reuse rules above.

Use one shared Meridian container per environment, with native Container lifecycle and port forwarding. Use Wrangler's `default` scheduling policy so Cloudflare owns image rollouts. Rebuild the complete profile configuration from the current vault, serialize startup and profile publication, and let model streams proceed outside that queue. Publish complete files atomically. Avoid independent environment-profile configuration that would create another credential source.

Shared secret save/delete operations must await profile publication after a successful subscription-token mutation. Keep this in the shared operation so Owner APIs, slate setup, and chrome agree. Publication failure reports failure after the vault write; it does not imply rollback. Other secret names must not start Meridian.

For hosted subscription access, including conversations in the DevEnv, obtain a token with `claude setup-token`, save it through the ordinary Owner-scoped secret command, and declare it with the desired owner/viewer mode. Docker is required for Meridian and the SlateAgent computer. Vault writes require the user's per-write authorization.

## Testing

See [TESTING.md](../../TESTING.md) for [manual verification](../../TESTING.md#manual-verification), [test execution](../../TESTING.md#running-tests), and [fixture ownership](../../TESTING.md#fixtures-and-resource-ownership).

## Dashboard Owner selection

The URL selects dashboard Owner; do not mutate Better Auth's active organization. Use web's native organization API for browser choices and authoritative organization records for server-side slug resolution. Return explicit `OwnerDetails` derived from the verified user or organization. Owner filters narrow an already-authorized listing and must never grant access.

After confirmed account switching, replace navigation with the Personal slate list. Omit `/dashboard` from React Router links because the basename supplies it. Share listing with OpenAPI through `listSlates`, and normalize validated Owner filters to canonical `Owner`.

## Slate-Owner billing access

Follow [billing ownership and admission policy](../../ARCHITECTURE.md#slate-owner-billing-access). Use Polar's native webhook verification and Customer State, with settings validated in `env.ts`. Acknowledge customer events only after their required native subscription creation or state persistence succeeds. Keep Polar's merchant organization distinct from the slate's owning organization; external customer identity is the Better Auth user/organization ID.

Keep `checkSlateBilling` separate from identity and viewing/management authorization. Resolution and delegated execution call it after viewing authorization; personal-account execution calls it after slate management. Apply the shared decision without authored-path exemptions, preserve the shared refusal through local/hosted Tools, and reuse web's billing destinations. Keep usage reporting asynchronous. Do not add a balance ledger, duplicate admission policy, or no-plan enrollment/backfill.

## Slate usage

Keep canonical Owner, the resolution contract, and Polar event weights in `@usecontextlayer/shared/slate-usage`; platform re-exports Owner and derives it from canonical slates through `getSlateOwner`. Keep presentation-only metadata in `OwnerDetails`.

After provider execution returns, record one `tool_call` clip from the execution boundary through shared `recordSlateUsage` and native `waitUntil`. Missing setup and authorization denials are not executions; returned Composio execution errors are. Bill the slate Owner, never the viewer. Preserve background failures instead of catching and discarding them.

## Chrome

Follow [the chrome boundary](../../ARCHITECTURE.md#slate-chrome) and [cross-site authentication](../../ARCHITECTURE.md#cross-site-chrome-authentication--principles). The SDK `Layout` mounts platform's iframe; keep its UI, styles, and fonts in platform. Reuse native web-session middleware and shared authorized domain operations. Authored loaders, Workers, and clips metering must not mediate chrome data.

The chrome loader consumes complete shared resource configuration, including canonical Owners and secret presence; do not assemble it again. Authorize Owner access before provider I/O and keep account catalogs inside trusted chrome. Use native loaders/actions for mutation and revalidation without a parallel client-side assignment store. Read profile data directly from web inside the frame.

Limit parent messages to presentation data and validate origin, source window, and payload. Never expose credentials, profile/configuration data, or an authenticated relay to the parent. Derive embedding and message origins from the loader's canonical slate hostname. Carry CSP through React Router loader headers and the route headers export; other dashboard documents deny framing. Treat the route manifest as public metadata without opening protected loaders. Use Hono's native CSRF middleware at cookie-authenticated mutation boundaries and preserve web's native origin checks; authored origins receive no credentialed CORS access.

## Slate database access and migrations

Use shared native `SlateDatabase` and `ctx.storage.sql` for storage/query execution. Platform owns prepared physical references and authorized instance selection; Build owns isolated migration execution and Kysely owns migration loading, ordering, and history. Follow [the migration contract](../../ARCHITECTURE.md#slate-databases-and-authored-migrations) and [Build's construction rules](../build/AGENTS.md). Pass the selected snapshot and targets into that shared phase; do not infer DDL from query types or use runtime query capabilities as migration connections.

Route hosted SQL through `querySlateDatabase`. The `Execution.queryDatabase` boundary validates the declared query and parameters, verifies viewer identity, and applies viewing/billing before using shared preparation. Expose no direct public HTTP query route. Dispatcher binds trusted Databases props to the authorized slate/viewer; app consumers select only app resources, and agent tools consume only their prepared resources. Keep physical namespaces and provisioning private. Follow [authored database development](../../DEVELOPING.md#authored-database-development) for migration authoring.
