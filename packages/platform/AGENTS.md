# Platform

Preserve conceptual integrity when extending platform: use the [canonical domain model](../../ARCHITECTURE.md#domain-model), keep one owner for each decision, and make new consumers use the same operations and contracts. A new route, UI, or execution path must not introduce its own meaning of Owner, membership, resource configuration, or job identity. These rules constrain future changes; they do not claim every requirement is implemented. [Documentation guidance](../../AGENTS.md#documentation) assigns architectural contracts, workflows, testing, and implementation history to their owning documents.

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

Reuse the pure resource-configuration resolver for whole-slate membership completeness and selected-resource request completeness. `prepareSlateResourceExecution` must resolve only the request's selected resources; call `addSlateMember` before resolving viewer-mode inputs for a private user. Owner-only requests must neither create membership nor depend on unrelated personal setup. Public users and app actors must be refused viewer-mode resources independently of any stored membership.

Keep insertion and initial provisioning in `addSlateMember`: only the request that inserts the unique relationship starts provisioning, using the prepared snapshot. Existing membership must return before setup reads and must not reinstall schedules. Commit membership before awaiting Workflow creation; do not hold a database transaction across provisioning or wait for background execution. Membership is not an authorization grant, a job submission, or a provisioning-readiness flag.

## Workers runtime

Use Cloudflare Workers through `react-router-hono-server/cloudflare` and the Cloudflare Vite plugin. Validate bindings in `env.ts`; pass domain functions only the native bindings they use and provider settings through parsed `PlatformConfig`. Framework contexts may carry individual dependencies for loaders/actions. Hono middleware owns the request's Postgres.js/Kysely connection, shares it with handlers and loaders, and closes it through `waitUntil`.

Keep React Router's `/dashboard/` basename separate from Vite's `/` asset base. Putting Vite modules under `/dashboard/` sends them through the dashboard authentication/routing gate. Use selective `assets.run_worker_first` so API, Git, and dashboard page/data requests reach their authorization boundaries while assets use native serving. Do not put assets under the dashboard basename or run the Worker first for every asset. Hosted-slate authorization belongs to dispatcher’s separate boundary.

Use native `ARTIFACTS` repository handles with `using` and the private `DATABASES` namespace for slate storage. Do not add runtime storage REST clients or API-token secrets. Keep environment selection in Wrangler configuration. Follow [DevEnv](../../DEVELOPING.md#devenv) for local startup and [TESTING.md](../../TESTING.md#fixtures-and-resource-ownership) for test bindings; local development and integrations must use resources isolated from production.

Use the [shared Worker deployment workflow](../../DEVELOPING.md#service-deployment).

### Local runtime

Use [DevEnv](../../DEVELOPING.md#devenv) for ordinary development with web, auth, dispatcher and Build. When running platform separately, `dev:watch` uses Cloudflare Vite with the source entrypoint; `dev` uses Wrangler with the compiled bundle and source Wrangler configuration. Run package tasks through the root [Turbo convention](../../DEVELOPING.md#workspace-commands). Both modes select `test`, run in workerd, and default to port 3010. There is no Node production server or `CTX_PLATFORM_PORT` setting.

Vite preview uses the bindings selected at build time; changing `CLOUDFLARE_ENV` only at preview startup does not select another namespace. The default `ARTIFACTS` and `SLATES` bindings select `contextlayer-prod`, so select the native `test` environment before building for local verification. Wrangler's `secrets.required` imports process configuration into Worker bindings.

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

Use `createAccountSession` for scoped Composio execution: it owns account/toolkit pinning, the native `direct_tools` preset, disabled connection management, and enabled Composio sandbox. Callers supply authorized account data, not policy overrides. Personal-account discovery/execution derives the personal Owner from verified native identity and must exclude viewer credentials in its domain type. A supplied account ID selects within that authority; slate management and billing remain separate requirements. Keep personal-account execution and hosted slug-based delegation distinct, sharing only the scoped provider primitives. Reused personal sessions must reauthorize the current personal account and verify Composio’s server-side session configuration; never treat a supplied session ID as authority. Publish native session Tool schemas and preserve the native execution result, while charging only actual executions through the existing slate usage boundary.

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

Keep `getAgentRun` as the common preparation path for API and scheduled jobs. Boundaries supply a canonical slate, explicit `AgentActor`, agent name, and prompt; schedules do not reconstruct HTTP authentication. Prepare the named agent's resources from the latest coherent snapshot. A scheduled firing must not reuse the commit that installed its schedule.

Pure `prepareAgentRun` consumes resolved configuration and returns the complete run. Do not construct a partial run and mutate it later or resolve Owners and assignments again in execution. Persist canonical resource references, actor, instructions, and source revision; exclude caller credentials, repository tokens, and secret values. Keep authored instructions in a native Pi prompt section and the triggering prompt as separate user input. Database tools consume prepared references through `SlateDatabase.query`, with input/output declarations derived from shared database schemas.

### Hosted agent runtime

Use the Cloudflare Agents/Pi runtime from `@usecontextlayer/shared`; platform validates its rich prepared run references and exports the native `AgentResources` and `AgentPreparation` entrypoints. Keep hosted Owner/reference validation and vault/Composio access in these trusted adapters, following the [portable execution boundary](../../ARCHITECTURE.md#authored-agents). Do not copy execution into platform or require hosted credentials in the shared runtime.

Use native Cloudflare `Agent` and `RoutedAgents` for stable slate/agent/actor scopes and a separate job namespace for execution. Integrate `PiHarness` through the job's Lifecycle with Pi Durable on its SQLite storage. Pi owns execution state, submissions, transcripts, and results; the Agents SDK owns the catalog and wakeups. Do not add a second execution ledger or translate Pi results into another agent vocabulary.

Keep admission inside the stable Agent's native concurrency boundary until the job has persisted its initial Pi receipt. Discovery must not expose a job whose operation has not been admitted. On failed initial submission, delete the new catalog entry and execution object through native `RoutedAgents.delete()` before releasing admission. Never hold admission while waiting for job completion.

Attach a native Cloudflare container to each job and use Pi's `CodingTools` with `RemoteExecutionEnv`. Keep filesystem and shell semantics in Pi. Direct and Code Mode calls must share that job's computer and prepared resource authority. Disable computer internet access; declared external integrations run in the trusted Worker. Observe native harness idle for connection cleanup rather than polling job results. API and scheduled jobs share fresh-computer creation; durable transcripts do not imply durable computer files.

Install native `createCodemodeExtension` and `createInlineCodemodeSandbox` in the existing job registry. Reuse registered tools and native discovery; do not create another tool catalog or a standalone search tool. The sandbox receives registered capabilities, never ambient Worker bindings, network, or filesystem access. Let native durable execution own deadlines, replay, and individual VM disposal. Register the sandbox and computer with the job's Lifecycle. Use the Cloudflare package's compiled WASM through the existing build, without another Worker or binding.

Build connection tools only from prepared references through `createAccountSession`. Persist native session IDs and reuse the same registration operation for admission and harness reconstruction. Obtain tool schemas and execute actions through the same scoped session; publish tools only after prepared state exists. Preserve native action schemas, namespace/deferred registration, and structured results. Derive result declarations from Composio's exported schemas and resolver; do not maintain an application-owned envelope or replace session responses with catalog wrappers. Keep credentials in trusted execution, loading literal vault values without interpolation. Loader/action Tools retain their own authority and billing.

### Agent job and inspection API

Register the shared agent Hono route definitions with platform-owned authentication. Keep agent job/catalog/schedule operations in shared and pass them already-authorized native scope stubs or prepared runs; hosted lookup, source/resource preparation and authorization remain in platform. Job APIs reject public slates. Apply viewing authorization to job submission, catalog discovery, and ordinary operation/results. Apply source-management authorization before schedule inspection, rich execution reads, or lifecycle mutations: their prompts and execution payloads can disclose authored source and private data.

Keep catalog, operation, and session identity distinct. Pi creates operation receipts; native catalog entries identify jobs. Callers must not choose physical addresses or conversations. Catalog metadata comes from the prepared actor and trusted trigger; scheduled provenance retains both the native schedule identity and authored name across reprovisioning. Catalog reads must not load execution state. Ordinary operation/results remain transcript-free; native inspection and messages serve their separate purposes.

Select authorized app/current-user scopes at the platform boundary and pass their native stubs to the shared operations. Return the native job stub through `SlateAgent.resolveJob`, acquire it with `using`, and await calls before disposal. Derive its interface from `SlateAgentJob` with inherited `Agent` members omitted so Workers applies RPC typing once. Do not copy method signatures, forward every job method through the parent, or expose physical addresses. Keep native catalog deletion on the parent and preserve native abort results independently of missing-job outcomes; do not add a pending-state deletion restriction or cleanup ledger.

Pass trusted typed RPC results through; do not reparse them into application-owned copies. Validate unknown inspection/message envelopes and generic schedule payloads at the shared domain boundary. Preserve native fields and opaque nested payloads in response schemas rather than rebuilding Pi's state machine. Schemas own field semantics, including timestamp units and the distinction between live inspection and completed messages.

### Agent schedule provisioning

Use the Agents SDK's frontmatter parser for authored schedule files; require five-field UTC cron and use the Markdown body as the prompt. Git remains the authoring authority. Native scheduling and Durable Object alarms own timing and recurrence; do not introduce a schedule configuration store or custom scheduler.

`prepareSlateProvisioning` must remain pure. Build and membership supply their selected snapshot and actors; preparation derives one `SlateProvisioning` value with deduplicated database targets. Migration and schedule phases consume it without selecting another revision or actor set. Read schedule files through the snapshot's discovered agent trees. Keep the optional build workspace backup separate from the prepared authority. Follow [the migration lifecycle](../../ARCHITECTURE.md#slate-databases-and-authored-migrations) and delegate migration execution to Build's [shared migration step](../build/AGENTS.md).

Derive unattended scope from each agent's own selected resources: any viewer requirement selects member scope; none selects app scope. Provision authored schedules only on supplied actors in that scope and cancel authored schedules on supplied actors outside it. Replace only authored `runScheduled` callbacks, preserving framework-owned lifecycle work. Each firing uses its stored actor with the common latest-snapshot preparation and job submission. A missing agent definition cancels that instance's authored schedules; missing assignments and transient failures must not cancel them.

### Hosted model configuration

Select a hosted model by declaring `ANTHROPIC_MODEL` as an owner- or viewer-mode secret in the agent's declaration and saving a supported full Anthropic model ID through the ordinary Owner-scoped secret command. Declare provider access separately through `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Follow [model ownership](../../ARCHITECTURE.md#authored-agents): only an undeclared model uses the code's default; a declared value is required. New API and scheduled jobs read current configuration, while existing conversations retain their selected model.

### Hosted subscription access

Select provider access from declared secrets: `ANTHROPIC_API_KEY` takes precedence; otherwise use `CLAUDE_CODE_OAUTH_TOKEN`. Never switch providers after authentication or provider failure. Resolve provider credentials independently of `ANTHROPIC_MODEL` through the same resource preparation.

Use the native Anthropic provider's catalog and streaming protocol, routing subscription fetches through the private `Meridian` service. Profile identity must derive from the canonical vault key, with job identity supplying session affinity. Keep subscription tokens out of persisted job configuration and the job's computer. Meridian's SDK session files are ephemeral; Pi owns the durable conversation.

Use the shared Meridian class and canonical Docker assets with its native MeridianProfiles entrypoint; platform supplies the current vault profile loader. Use one shared Meridian container per environment, with native Container lifecycle and port forwarding. Use Wrangler's `default` scheduling policy so Cloudflare owns image rollouts. Rebuild the complete profile configuration from the current vault, serialize startup and profile publication, and let model streams proceed outside that queue. Publish complete files atomically. Avoid independent environment-profile configuration that would create another credential source.

Shared secret save/delete operations must await profile publication after a successful subscription-token mutation. Keep this in the shared operation so Owner APIs, slate setup, and chrome agree. Publication failure reports failure after the vault write; it does not imply rollback. Other secret names must not start Meridian.

For local slate subscription access, obtain a token with `claude setup-token`, declare it with the desired owner/viewer mode, and supply it through the local startup environment. Hosted subscription access loads the selected Owner vault through ordinary Owner-scoped secret operations. Docker is required for Meridian and the job computer. Vault writes require the user's per-write authorization.

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
