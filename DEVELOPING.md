# Developing

This workspace contains nine packages: the public `@usecontextlayer/cli` and `@usecontextlayer/sdk` plus seven private packages, including the platform application and viewer auth Worker. Use the root package scripts and Turbo for libraries and applications. Main pushes run checks; version-tag pushes publish npm packages.

## Setup

Run from the repository root:

```sh
mise trust
mise install
pnpm install --frozen-lockfile
```

`mise.toml` provides Node and pnpm; the pnpm version must match `package.json`. Corepack stays unused. `pnpm-workspace.yaml` enforces the Node version floor and disables automatic dependency repair during task execution, so install dependencies explicitly before running tasks.

## Workspace commands

```sh
pnpm run check
pnpm run format.verify
pnpm run tsc
pnpm test
pnpm run build
```

`check` runs workspace-reference and Tailwind checks, fixes formatting, and typechecks. `format.verify` checks without editing files. The Tailwind checker discovers stylesheet entry points across `packages/`; it reports explicitly when there are no Tailwind stylesheets to scan.

For package-scoped work, use Turbo selectors:

```sh
pnpm exec turbo run build tsc --filter=@usecontextlayer/shared...
pnpm exec turbo run test --filter=@usecontextlayer/shared...
pnpm exec turbo run dev:watch --filter=@usecontextlayer/db-infra...
```

A library carries `dev:watch` for rebuilding its output. The general task convention remains: a server's `dev` starts it, `dev:watch` adds watching, and a package defines only the forms it actually uses. Turbo owns dependency builds through `^build`.

## Building platform capabilities

Design almost every capability offered by the web dashboard as an OpenAPI operation usable by the CLI and a future MCP consumer. Define its Zod input/output contract and shared domain function, including authorization and database calls; connect the API handler and React Router loader/action to that same function. Loaders/actions call it in-process. Verify the product operation through its existing API or CLI path and verify the browser interaction where needed. Browser presentation belongs in the UI; authentication protocol handling belongs to Better Auth.

## CLI development

The new `ctx login` / `ctx whoami` flow requires web with its OAuth device extension migrated and a public CLI client registered for the `urn:ctx:platform` resource. `CTX_AUTH_ISSUER` defaults to `https://www.usecontextlayer.com/api/auth` in CLI and platform; `CTX_AUTH_CLIENT_ID` defaults to the registered production public client ID in the CLI. Configure both CLI and platform with the same issuer for local testing, and point `CTX_PLATFORM_URL` at that platform. Only localhost/127.0.0.1 issuers permit HTTP in the CLI. Credentials are written to `~/.contextlayer/auth.json` with owner-only permissions on creation. Local and production end-to-end login and authenticated `whoami` passed. Production web is migrated, the public client is registered, and platform verifies its tokens. The CLI targets production by default; set `CTX_PLATFORM_URL=http://localhost:3010` to use the local platform. CLI authentication is included in npm releases starting with 0.12.0.
Build the local `ctx` executable, then invoke the built executable from the repository root:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/cli
pnpm ctx --version
pnpm ctx init my-react-router-app
```

Run the built CLI's `ctx login` once to register its credential helper for this OS user, including when you already have a saved login from an earlier version. Registration points Git at the executable used for login; run login again if that installation moves. Git needs native `authtype` credential support (the development machine's Git 2.55.0 advertises it). Login and init must target the same platform URL so Git's registered URL scope matches the remote.

Create test projects outside this checkout. Create Cloudflare reuses an enclosing Git repository instead of initializing a nested one, so testing inside this repo prevents the generated project from having its own Git root and origin. The pnpm executable must also work from the generated project's directory; a machine-wide mise default supplies it outside repo-local tool configuration, without `mise exec` or a CLI workaround.

`ctx init <directory>` uses the official Cloudflare React Router scaffold through `pnpm create cloudflare@latest`, accepting defaults, initializing Git, and disabling deployment. The generated project owns its `pnpm dev` and `pnpm build` commands; its Cloudflare Vite plugin runs server code in the Workers runtime. After scaffolding, it installs the matching release of `@usecontextlayer/sdk` and Zod, overlays the local Tools Worker and native Vite service-binding configuration, and creates an app through `POST /api/apps`, then sets `origin` to `<CTX_PLATFORM_URL>/git/<app-id>`. The platform assigns an immutable UUID and a friendly public hostname. `CTX_PLATFORM_URL` is read in the CLI's `env.ts` and defaults to `https://slate.usecontextlayer.com`. Initialization includes `public/slate.json` with empty connection and secret requirements, served as `/slate.json` through native static assets; `ARCHITECTURE.md` owns this contract. Initialization does not push. Relative directories resolve from the calling directory. The version comes from `packages/cli/package.json`. Run `pnpm exec turbo run dev:watch --filter=@usecontextlayer/cli` to rebuild the CLI as its source changes.

## Platform viewer authentication

Platform's general APIs, Git, and dashboard accept CLI access tokens in Authorization: Bearer or native Better Auth web cookies. Only GET /api/apps/resolve and POST /api/apps/:target/tools/call additionally accept ctx-viewer-auth. Web's /api/me and /api/platform/organizations reject the viewer cookie. Runtime viewer authentication still checks the copied session through web's /api/auth/get-session using the bearer plugin; no token format, sign-in, or logout mechanism changed. Explicit bearer credentials take precedence. Private-organization viewing sends the viewer cookie to web’s dedicated GET /api/viewer/organizations/:organizationId/membership endpoint. Web validates the existing session and returns {isMember}; platform applies its own viewing policy. Native web and CLI membership reads retain /api/platform/organizations.

For native browser session development, run web at `http://localhost:3000`, set `CTX_AUTH_ISSUER=http://localhost:3000/api/auth` in Doppler `platform/dev`, and open platform at `http://localhost:3030/dashboard/personal/apps` after starting its Vite server on port 3030. Use localhost for both browser URLs: cookies are shared across ports, but localhost and 127.0.0.1 are different cookie hosts. Sign into web normally, then open platform. These cookies are verified against local web, so CLI credentials must come from that same issuer for an identity comparison. Restoring the production issuer resumes production CLI/viewer checks. Production web shares its native cookie across `usecontextlayer.com` using Better Auth’s `crossSubDomainCookies` configuration.

Signed-out browser navigation to the dashboard redirects to web's existing sign-in page with the original dashboard URL in `redirectTo`. The existing social sign-in UI forwards it to Better Auth's `callbackURL`; local web already trusts localhost ports. Dashboard fetch/data requests retain 401 through native `Accept` negotiation, and API/Git routes always retain 401. To check the redirect with curl, send `Accept: text/html`; curl's default wildcard header receives 401. The sign-in round trip has been verified locally and in production. Web explicitly trusts `https://slate.usecontextlayer.com` as a production sign-in callback origin; no additional secret or schema migration is required.

For local identity verification, run ctx whoami against the matching web issuer; native web cookies and CLI tokens should authenticate /api/me, while a viewer cookie should return 401 on both web profile and organization endpoints. Platform should accept that viewer cookie for private personal app resolution and tool authentication, and reject it on general APIs. The auth.node.integration.test.ts check exercises these platform boundaries with real Better Auth sessions and an isolated local Postgres database; run pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- auth.node.integration.test.ts. It performs no external provider calls.

## App ownership

Run `ctx login` before `ctx init`. Initialization reads the saved login before scaffolding and authenticates `POST /api/apps`. The platform resolves an optional `organization_slug` from the JSON body against web’s organization records for the verified caller; a match creates an app with that organization ID and `owner_user_id` null. A slug outside those memberships returns 404 before any database or Artifacts write. Omitting it records the verified user as `owner_user_id`, with `owner_organization_id` null. See `ctx init --help` for organization selection. Migration 003 adds both nullable text columns and PostgreSQL's `app_exactly_one_owner` check: exactly one column must be non-null. Domain creation owns selection of the typed user-or-organization owner. Git source access and app listing enforce the owner/member management rule. Viewing authorization applies to hostname resolution and app connection/tool APIs. Users and organizations remain in web's Better Auth database.

Organization-owned and default personal initialization are verified locally through an approved native CLI device login. Both generated projects had independent Git repositories and immutable AppID remotes, passed authenticated native Git reads, and appeared only in the corresponding dashboard workspace and API owner filter. Native browser-cookie authentication returned the same user as the CLI and rendered the organization app. Anonymous creation returned 401, and creation for an organization absent from the caller's memberships returned 404. The generated organization app passed its native typecheck and client/server production build.

Migration 003 requires every existing app to have an owner. Resolve existing rows before running it; there is no automatic backfill or deletion in the migration. The user-authorized production cleanup on 2026-10-03 removed the three existing app rows and their cascading connection assignments, and migration 003 is applied to production. Production migrations run separately from the main-push deployment pipeline.

Migration 004 adds non-null text `app.visibility` and backfills existing apps to `private`. App creation explicitly supplies the private default from the code constant `DEFAULT_APP_VISIBILITY`; the database has no visibility check or persistent default. Zod validates the public/private values when app rows are returned. Apply migration 004 before running this version against an existing database. It is verified in an isolated local database and applied to production on 2026-10-03. Main pushes deploy the matching Worker code through the existing Cloudflare Workers Builds pipeline. Platform hostname resolution enforces public/private viewing and dispatcher consumes its decision for every app path. Every route in the `/apps/:target` operation group inherits required authentication and the same viewing authorization before its handler; connection listing, assignment, and tool execution take the resulting app-and-caller `AppAccess` input; Git source access and management listing enforce ownership independent of visibility. `PATCH /api/apps/{target}` accepts JSON visibility (`public` or `private`) and returns the saved app; the shared `updateAppVisibility` function requires its owner or an owning-organization member before writing. Public viewers cannot change visibility. This uses the existing column and requires no additional migration. Each app row has a Public / Private radio dropdown composed from the existing shadcn components. Its React Router action validates the form using the shared visibility schema and app target, then calls the same domain update. useFetcher submits without navigating and revalidates the loader after saving; the row displays the persisted value.

## Local app tools

The root Tailwind deprecation checker owns its compiler and scanner as development dependencies. It checks package-owned stylesheets; SDK chrome now uses platform styles instead of shipping a separate stylesheet. React Router app templates retain native generated `./+types/...` imports and use `~` for ordinary app imports.

New apps re-export only Layout from `@usecontextlayer/sdk/react`; remove the old SDK loader re-export when upgrading. Layout embeds platform's chrome page, which owns its styles, font, profile, and connection reads. The generated app retains its Tailwind and shadcn nova/Base UI setup. Verify unpublished changes with locally packed CLI and SDK packages and the generated app's own typecheck/build. The SDK has no stylesheet export or inline/font asset imports for the app to compile. In development the existing Vite integration exposes only AppID, platform URL, and manifest snapshot through native defines; it does not expose CLI credentials. Chrome uses a browser session, independently of local Tools using the saved CLI login.

Sign in with `ctx login`, declare connection requirements in `public/slate.json`, and assign a Composio Platform connection belonging to the selected Owner using the local CLI target. Connection command help owns account authorization/listing and organization selection. For an organization-owned app's owner requirement, authorize and list the account under that organization before assigning it. The member completing OAuth manages an organization-owned account; setup and execution use the organization's same Composio identity. Run local mode from the app root; it reads the manifest and Git origin without searching parent directories. The platform authorizes the canonical app and uses each manifest requirement’s viewer/owner mode to select the canonical Owner for its assignment. Owner assignment requires app management; viewer assignment uses the acting user. Local manifest substitution for assignment or execution also requires app management. A private personal app requires its owner; a private organization app requires membership in its owning organization, independent of the active workspace. Public apps still require sign-in for personal listing, assignment, and execution, and viewer-mode requirements remain scoped to the acting user’s credentials. Authored owner-mode requirements execute with the app Owner’s configured account.

The generated app installs `@usecontextlayer/sdk`; it depends on the CLI for saved-login access. Its Vite configuration composes `contextlayer(env)` from `@usecontextlayer/sdk/vite` with the React Router and Tailwind plugins. The packaged integration calls `getLocalToolsBindings` only during development. This reads the Git-origin AppID and the CLI's saved login, refreshing an expired access token before startup. The Cloudflare plugin configures the Tools service binding with native props containing the AppID, CLI credential, and parsed manifest; only the platform URL is an auxiliary Worker variable. The auxiliary Worker re-exports the same Tools implementation as dispatcher. No Composio key or manually copied token is needed. Restart `pnpm dev` after the access token expires or the manifest changes.

`pnpm dev` starts both Workers through the Cloudflare Vite plugin; there is no separate tools server or `ctx dev` command. The local Worker calls `POST /api/apps/{id}/tools/call`, and the platform resolves the manifest-selected Owner’s assignment before executing through Composio. Local credentials and the auxiliary Worker are excluded from production builds. The CLI installs matching first-party package versions and exempts `@usecontextlayer/*` from pnpm's release-age policy.

[The SDK README](packages/sdk/README.md) documents the loader API and Gmail example. [Architecture](ARCHITECTURE.md) owns the connection-slug contract and runtime boundaries. The deployed dispatcher supplies hosted Tools through native request-scoped RPC. When verifying unpublished source, install locally packed CLI and SDK packages in the generated app.

## Manifest Owner selection verification

Platform’s APPS binding uses the same contextlayer-dev namespace as dispatcher. Native remote bindings let local platform reads reach deployed user Workers without forwarding the caller’s authentication. Supplying the existing local manifest request field uses the validated startup snapshot instead; its local provenance retains existing management authorization for assignment and execution. Domain operations receive ManifestSnapshot and perform no deployed-manifest fetch themselves.

Migration 006 preserves existing connection assignments as user Owners and enables organization Owner assignments. Apply it to an existing database before deploying the new code, and update app manifests from `individual`/`shared` to `viewer`/`owner`. The shared manifest schema accepts named secret requirements with the same modes; declarations contain no values and need no secret-assignment record. Secret loading remains part of hosted execution.

`connection-owner.node.integration.test.ts` uses two disposable Postgres databases and the production migration, listing, assignment, and execution-resolution operations. It checks preserved legacy rows, viewer/app-owner selection, organization Owner storage, and management authorization for local declarations. It performs no Composio execution or remote vault writes. Run through Turbo:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- connection-owner.node.integration.test.ts
```

Agent-run preparation is internal to `packages/platform/app/agents.server.ts`: `getAgentRun` loads published instructions and deployed requirements for authorized app access, while pure `prepareAgentRun` builds the serializable instructions/task/Owner-reference description. `agents.test.ts` verifies the preparation contract for personal and organization app Owners and a distinct acting user; it does not fake Artifacts, web, or Doppler. Run with `pnpm exec turbo run test --filter=@usecontextlayer/platform`. The existing `platform.node.integration.test.ts` verifies the shared source reader and preparation using a real built Worker, native Git publication/clone, and the published fixture's instructions and manifest. That case does not exercise the composed `getAgentRun` dispatch-binding manifest read. It needs the normal platform configuration and `CTX_TEST_ACCESS_TOKEN` issued by the matching auth server/client; run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- platform.node.integration.test.ts`. Hosted execution remains unimplemented.

## Platform development

Platform runs in Cloudflare Workers. Local tooling needs Node 24.19+, a migrated Postgres database, and Wrangler authentication for the Cloudflare Artifacts namespace. Put `CTX_PLATFORM_DATABASE_URL`, the Polar endpoint signing secret `POLAR_WEBHOOK_SECRET`, the sandbox `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT=sandbox`, and the Composio Platform project key `COMPOSIO_API_KEY` in Doppler `platform/dev`. Set `CTX_AUTH_ISSUER` there to the auth server used for local verification. Wrangler’s native `secrets.required` declaration imports the selected Doppler-injected process variables into Worker bindings; do not maintain a `.dev.vars` copy. `CTX_APPS_DOMAIN` defaults to `contextlayer.xyz`. The native `ARTIFACTS` binding in `wrangler.jsonc` selects `contextlayer-dev` and uses the remote namespace during local development. The Worker needs no Cloudflare API token at runtime. Production database configuration lives in Doppler `platform/prod`; Neon’s `platform` project owns the production database.

From the repository root, use `doppler run -p platform -c dev -- pnpm dev:watch` for React Router/Vite watching. For built preview, build with `doppler run -p platform -c dev -- pnpm exec turbo run build --filter=@usecontextlayer/platform`, then start with `doppler run -p platform -c dev -- pnpm dev`. Platform starts at `http://localhost:3010/dashboard/personal/apps`. The Cloudflare Vite plugin may generate an ignored `.dev.vars` snapshot in build output for preview; Doppler remains the source of configuration. Development and preview run in workerd through the Cloudflare Vite plugin. Both default to port 3010; use Vite’s `--port` option to change it. There is no Node production server or `CTX_PLATFORM_PORT` setting. Provision a separate logical platform database on the shared Postgres instance before starting. Run `doppler run -p platform -c dev -- pnpm exec turbo run db.latest --filter=@usecontextlayer/platform` to migrate and regenerate Kanel types. The server consumes the configured database; it does not create or migrate it during startup.

Vite prints the server root URL; open `/dashboard/personal/apps` for the dashboard. Its route basename is `/dashboard/`, but Vite's asset base is `/`, so dev modules and CSS use `/app/...` and `/@vite/...`, and production bundles use `/assets/...`. Cloudflare runs the Worker first for `/api/*`, `/git/*`, and `/dashboard/*` only. Protected dashboard page/data, API, and Git requests require sign-in. Chrome permits anonymous rendering, and `/dashboard/__manifest` serves public route metadata; API discovery and authorized public viewing retain their public behavior. Scripts and styles use native asset serving. Changing Vite's base to `/dashboard/` would put its modules inside the dashboard authentication/routing gate.

Run `CTX_PLATFORM_URL=http://localhost:3010 pnpm ctx init <directory>` against the running local platform, then push the project's commit with `git push origin HEAD:main`. The app appears at `/dashboard/personal/apps` immediately after initialization. The Git remote uses the app UUID permanently. `/git/...` proxies Git traffic using repository-scoped tokens held by the server. `GET /api/apps` returns `{ "apps": [{ "id": "…", "owner_user_id": "…", "owner_organization_id": null, "public_hostname": "…", "visibility": "private", "latest_commit": "…" }] }`; `/api/openapi.json` describes creation, listing, hostname resolution, and visibility updates. `GET /api/apps/resolve?hostname=<public-hostname>&pathname=<incoming-path>` returns the authorized `{ "id": "…" }`, 401 when private viewing needs sign-in, 403 when the signed-in user lacks access, 404 when unassigned, or 402 when the owner lacks an active subscription (except exactly `/slate.json`). Private organization viewing uses web’s `/api/viewer/organizations/:organizationId/membership` endpoint for viewer sessions and `/api/platform/organizations` for native web or CLI credentials. Deploy the web membership endpoint before the matching platform change. Listing reads the latest commit on main directly from Artifacts; latest_commit is null before the first commit. The dashboard shows its seven-character SHA beneath the app link. Git clone/pull/push require the owner or a member of the owning organization, including public apps. The platform server verifies identity once per request; the API app catalog and dashboard listing require that identity and return only manageable apps. Listing retrieves organization memberships once before applying the shared pure owner/member rule. The dashboard accepts CLI bearer or native web-cookie credentials. HTML navigation redirects signed-out users through web’s existing sign-in page.

Build platform and CLI before running the platform integration suite. It uses the built CLI as a native Git credential helper with an isolated temporary Git configuration; it never changes your global Git configuration. The platform integration test provisions its own database, starts the built Worker with `wrangler dev build/server/index.js --config wrangler.jsonc --no-bundle` and the test’s validated configuration in its child process environment, checks anonymous creation returns 401, creates an app through the real API using `CTX_TEST_ACCESS_TOKEN`, verifies its owner matches web's `/api/me` and its visibility is private, checks listing and rendering, saves public/private visibility through PATCH and verifies persistence and anonymous viewing responses, denies non-owner updates for private and public apps without changing the stored value, saves both visibility values through the real dashboard form action and checks rendering/persistence/viewing responses, denies dashboard updates by a public app’s non-owner, pushes and clones through its UUID remote, and pushes an update. It deletes its own Artifacts repository through the same installed Wrangler and drops its database. It requires Wrangler authentication, `COMPOSIO_API_KEY` and `POLAR_WEBHOOK_SECRET` for the platform environment, a current CLI bearer token in `CTX_TEST_ACCESS_TOKEN`, plus the shared local Postgres instance. The separate ownership integration test uses only local Postgres and checks that apps can have either owner but cannot have zero or two:

```sh
doppler run -p platform -c dev -- pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform
```

The dashboard uses the private Font Awesome npm kit described in [`.font-awesome.md`](.font-awesome.md). The repository maps its npm scopes in `.npmrc`; configure the Font Awesome package token in your user npm configuration before installing dependencies. Never commit that token.

## Shared secret management verification

Build platform and CLI before verifying Owner-owned secret management. The built CLI's `secrets --help`, `secrets set --help`, and `secrets drop --help` own input and Owner-selection syntax. Use the same auth issuer/client as the saved CLI login. Doppler `platform/dev` supplies `CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT=customer-credentials-local`, `CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG=prod`, and a read/write service token scoped to that vault as `CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN`. Production `platform/prod` supplies the corresponding settings for `customer-credentials/prod`. The production deployment script forwards these three settings into the platform Worker; these settings are not forwarded to dispatcher. Provisioning or changing Doppler tokens/config/secrets remains user-owned. Without that token, unrelated platform routes still work and authorized secret operations fail loudly.

`secrets.node.integration.test.ts` starts the real built Worker with an isolated migrated database and invokes the built CLI. Its non-writing cases exercise secret and connection anonymous/other-Owner denial, OpenAPI discovery, the absence of a plaintext secret GET operation, explicit stdin guidance, and unknown organization slugs. Connection verification also lists real personal and organization Composio accounts through the API and CLI; no authorization link or provider account is created. They need the normal platform environment, local Postgres, a current `CTX_TEST_ACCESS_TOKEN`, `CTX_TEST_ORGANIZATION_SLUG` for a membership, and the saved CLI login with matching `CTX_AUTH_ISSUER` and `CTX_AUTH_CLIENT_ID`. Run only those cases without a vault token:

```sh
doppler run -p platform -c dev -- pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- secrets.node.integration.test.ts --testNamePattern non-writing
```

The live Doppler case additionally needs the config-scoped token, `CTX_TEST_ORGANIZATION_SLUG` for an organization in the caller's memberships, and an unused `CTX_TEST_SECRET_NAME` beginning `CTX_SECRET_E2E_`. Obtain explicit permission for each write before running it. It creates a personal secret through CLI stdin, creates an organization secret with the same name through CLI stdin, replaces the personal value through PUT, replaces the organization value through CLI stdin, then drops the personal secret through CLI and the organization secret through DELETE. Those are exactly six provider mutations, all in the vault selected by the supplied platform configuration (normally `customer-credentials-local/prod` for local verification), at keys generated from those two Owners and the selected name. It reads the real provider's raw value to verify exact stdin preservation, Owner isolation, replacement, and deletion (a missing key returns HTTP 200 with `value.raw: null`); that test-only observation adds no runtime loader or public read API. It also checks CLI/Worker output for values and credentials without printing them. A failed live run stops and can leave its test secrets present; inspect and agree cleanup before any further write.

Verify interactive password entry once through the actual CLI in a terminal during the approved live Doppler proof, and record the observed result. Clack owns masking and cancellation; do not automate its terminal renderer or add pseudo-terminal plumbing to this suite.

```sh
doppler run -p platform -c dev -- pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- secrets.node.integration.test.ts
```

## Publishing and inspecting an agent

Add `agents/<name>/instructions.md` to an app project and push through its normal `/git/<app-id>` remote. See [Authored agents](ARCHITECTURE.md#authored-agents) for inspection, authorization, and revision semantics.

The existing `platform.node.integration.test.ts` exercises publication and inspection through real native Git pushes, a local built Worker, isolated Postgres, and remote Artifacts. It checks the initial instructions and commit and verifies a subsequent push changes both, alongside the existing source-access checks. Build platform and CLI first, then target that file through Turbo:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/platform --filter=@usecontextlayer/cli
doppler run -p platform -c dev -- pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- platform.node.integration.test.ts
```

## Running an agent locally

Build the CLI with `pnpm exec turbo run build tsc --filter=@usecontextlayer/cli`. From an app root containing `agents/<name>/instructions.md`, use `ctx agent --help` for the local-run command. When verifying unpublished source from another directory, invoke the checkout's built `packages/cli/dist/cli.mjs` with Node using its absolute path. Claude Agent SDK uses native Claude authentication, so an existing Claude login or SDK-supported model credential must be available. No ContextLayer server or login is involved.

See [Authored agents](ARCHITECTURE.md#authored-agents) for local instruction composition and settings isolation. Verify instruction behavior with a real local task; model output is observational evidence, while the SDK's preset/append contract establishes system-role composition. Do not replace that verification with mocked SDK messages or an assertion on the exact wording of a model response.

## Build Worker

`packages/build` owns the Cloudflare CI pipeline. Build and typecheck it from the repository root with `pnpm exec turbo run build tsc --filter=@usecontextlayer/build`. Building the configured Sandbox image requires Docker. The worker uses Wrangler directly because the current `cf` configuration cannot represent Artifacts push-event triggers.

The `contextlayer-build-backups` R2 bucket stores SDK workspace snapshots. Supply bucket-scoped Object Read & Write credentials as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the ignored `packages/build/.dev.vars`. Deploy from `packages/build` with `pnpm exec wrangler deploy --secrets-file .dev.vars` using a Cloudflare identity authorized for the configured account. These are snapshot credentials. Supply a Workers deployment API token as `CF_TOKEN` in the same ignored file. The SDK passes it only to the chained deployment runner, not the build runner.

Push a project created by `ctx init` through the running platform’s Git endpoint. In the Cloudflare dashboard, open Workflows → `contextlayer-build` and inspect the new instance’s `build` step. Its command output and status show whether the pushed commit built; a successful result includes the SDK’s workspace snapshot. Cloudflare account access is required to inspect these runs. The chained `deploy` step uses Wrangler to upload the built Worker and client assets to WfP under the AppID. Inspect both steps to confirm deployment.

## Dispatch Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/dispatcher`. Deploy from `packages/dispatcher` with `pnpm exec wrangler deploy`, using an identity authorized for the configured Cloudflare account. The user approved Wrangler for both Workers. The `contextlayer-dev` WfP namespace must exist before deployment.

The wildcard DNS record for `*.contextlayer.xyz` is proxied. Wrangler attaches that route to `contextlayer-dispatcher`. The dispatcher’s `CTX_PLATFORM_URL` is `https://slate.usecontextlayer.com`. App routing uses the deployed platform and Neon database; no local server or tunnel is required. Existing local app records were intentionally not migrated. Dispatcher forwards the incoming hostname, actual URL pathname and available CLI bearer or viewer cookie to platform's resolution endpoint. A 200 dispatches by AppID, a 401 redirects to auth's `/start` with `return_to`, and other failures pass through. It strips Authorization and the viewer cookie before authored code receives the request. `/slate.json` follows the same app viewing rule; platform connection listing forwards the verified caller's credential when fetching deployed requirements.

## Viewer auth Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/auth --filter=@usecontextlayer/dispatcher`. Auth uses Wrangler on `auth.contextlayer.xyz/*`, more specific than dispatcher's wildcard. Web must expose `/viewer/sign-in` and enable Better Auth's one-time-token and bearer plugins before deploying these Workers.

Neither Worker requires viewer secrets. Auth's `CTX_AUTH_ISSUER` defaults to `https://www.usecontextlayer.com/api/auth`; dispatcher uses `CTX_VIEWER_AUTH_URL`, defaulting to `https://auth.contextlayer.xyz`, and auth uses `CTX_APPS_DOMAIN`, defaulting to `contextlayer.xyz`. Web's `CTX_VIEWER_AUTH_URL` fixes the allowed callback destination. Configure these through package-local `env.ts` schemas. Dispatcher leaves identity verification and app viewing decisions to platform. Logging out on web must make the next private app request require sign-in; public apps remain anonymously viewable.

Web's handoff support and the shared-session auth/dispatcher Workers are deployed. The user verified production sign-in and logout. The obsolete viewer credentials have been removed from Doppler and both Workers; each Worker now has an empty secret list. The obsolete viewer OAuth registration has been deleted. Web commit `276b9d3` is deployed, removing the unused openid scope and OIDC-specific test. The CLI OAuth client remains in use.

## Tests and local Postgres

`pnpm test` runs the unit tier. `AGENTS.md` and `vitest.shared.ts` define the Node/browser runtimes and node/browser/Claude integration tiers. CI runs unit tests; integration tests are opt-in. The current packages have Node unit tests in shared, dispatcher, and platform and Node integration tests in db-infra (Postgres) and platform (Cloudflare Artifacts, Polar sandbox and Postgres); browser and Claude tasks remain available for future package tests.

The db-infra integration suite needs the shared local Postgres instance on `127.0.0.1:6489`. If it is not running, start it once:

```sh
docker compose up -d postgres
```

Then run the suite through Turbo:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/db-infra...
```

The suite provisions fresh, uniquely named databases through `@usecontextlayer/db-infra/ephemeral` and reclaims them after use. Do not stop, restart, or reset the shared Postgres instance. Reclaim only databases your session created; report suspected leftovers and ask before cleaning up another session's resources. An interrupted test can leave databases behind, so a prefix alone never proves a database is safe to delete.

The root commands `test:integration:node`, `test:integration:browser`, and `test:integration:claude` select individual tiers. `test:integration` requests all three. Packages define a tier's task only when they have tests for it; browser and Claude currently have no suites.

## Releases and deployment

The platform is deployed at `https://slate.usecontextlayer.com`. Cloudflare Workers Builds watches `main` in `usecontextlayer/contextlayer`, with repository root `/`, build command `bash packages/platform/scripts/build-cloudflare.sh`, and deploy command `bash packages/platform/scripts/deploy-cloudflare.sh`. This pipeline is separate from the GitHub package-release workflows below. Build variables pin `NODE_VERSION=24.19.0`, `PNPM_VERSION=11.22.0`, and `SKIP_DEPENDENCY_INSTALL=true` so registry authentication is available before installation.

Auth and dispatcher also have native Cloudflare Workers Builds connections to the same GitHub repository on `main`, root `/`. They use `bash packages/platform/scripts/build-cloudflare.sh` with `@usecontextlayer/auth` or `@usecontextlayer/dispatcher` as its argument, then auth uses `pnpm --dir packages/auth exec wrangler deploy`, while dispatcher uses `bash packages/platform/scripts/deploy-cloudflare.sh dispatcher` to supply its Polar runtime configuration. They use the same build-time Node/pnpm settings as platform. Auth needs no runtime secrets; dispatcher requires its Polar token and matching environment for usage ingestion. The shared script defaults to platform when no package argument is supplied. All three automatic deployment pipelines were verified successfully from main commit `a92dd9f`.

All three build configurations share the read-only `Cloudflare Workers Builds` service token from Doppler `platform/prod` as the Cloudflare **build secret** `DOPPLER_TOKEN`. The build script installs the official Doppler CLI and fetches `FONTAWESOME_PACKAGE_TOKEN` for pnpm through its CI-only npm configuration. Platform's deployment script fetches `CTX_AUTH_ISSUER`, `CTX_PLATFORM_DATABASE_URL`, `COMPOSIO_API_KEY`, `POLAR_WEBHOOK_SECRET`, `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT`, and `CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT`, `CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG`, and `CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN` into a temporary secrets file and passes it to Wrangler with the built Worker configuration. Auth, database, Composio, Polar, and the customer-credentials vault settings and config-scoped token are platform runtime configuration; the build Doppler and registry credentials stay in the build environment. Dispatcher receives only its Polar runtime configuration. Doppler changes take effect on the next deployment, not immediately when edited. Production uses Neon's `platform` project and its `production` branch; existing local app records were intentionally not migrated.

Use the release tool's help for its commands, options, and stopping points:

```sh
node --import tsx scripts/release.ts --help
node --import tsx scripts/release.ts audit
node --import tsx scripts/release.ts verify
```

The release ladder bumps package versions and the lockfile, commits with `gitc`, pushes main, waits for its `check.yml` run, and pushes a version tag. Pushing `vX.Y.Z` starts `release.yml`, which requires a successful check for that exact commit and verifies every package version against the tag before publishing. Its final rung watches the release run. Manual workflow dispatch remains available. Only packages without `private: true` publish; currently these are `@usecontextlayer/cli` and `@usecontextlayer/sdk`. GitHub receives `NPM_TOKEN` and `FONTAWESOME_PACKAGE_TOKEN` through Doppler sync. The former publishes packages; the latter installs the dashboard's private icons during CI. Releases do not deploy Twilio.

The CLI package exposes the `ctx` executable. Run it without a global installation using `npx @usecontextlayer/cli --version` or `npx @usecontextlayer/cli init my-app`.

`packages/twilio/README.md` owns its service configuration and deployment details. The old product deployment stack is absent; do not recreate its images or services as part of routine setup.

## Faux worktrees and change summaries

A faux worktree is a sibling clone made by `setup-faux-worktree <existing_folder> <new_branch>` and removed by `close-faux-worktree`; it has its own `.git`, so Git worktree commands do not apply. Always ask before creating one for a spec. One worktree per spec is the usual shape described in `PRODUCT-DEVELOPMENT-v1.md`.

`/describe-changes` narrates a range's actual behavior and files. `/close-faux-worktree` owns the landing sequence: current CI-equivalent gates plus all local integration tiers before merging. Account for every failure and skip; do not silently drop a landing gate.

## Skills

The third-party skills are owned by `npx skills` and `skills-lock.json`; never hand-edit installed skill content or the lock. `.agents/skills` is the store and `.claude/skills` is the view. The skill store is excluded from root Biome checks so installed content keeps its upstream formatting. Reconcile the view with `skills-sync`, without hand-maintaining symlinks. After a skills operation, format the changed lock/config files and verify formatting; include those formatting changes alongside the skill update when committing.

## Doppler

Local platform and deployed-service configuration live in the ContextLayer workplace. Authentication is directory-scoped and case-sensitive: run `doppler me` before use and stop if it reports another workplace or no scoped token. Do not borrow a token or log in ad hoc to bypass a missing directory scope.

Pass the project and config explicitly with `doppler run -p <project> -c <config> -- <cmd>`. Reads are fine; creating or changing projects, configs, or secrets is user-territory. Propose the exact change to the user.

Configs inherit values from their environment's root config and override only their local settings. Set shared values at the root rather than duplicating them in branch configs. A branch's secret listing includes inherited values, so presence does not establish that the value was set on that branch.

## Cloudflare and Fly.io

For Cloudflare operations, use `npx cf`; configuration stays in Wrangler's format. The Workers in `packages/platform`, `packages/build`, and `packages/dispatcher` use `pnpm exec wrangler` for build and deployment, as explicitly approved by the user. The current `cf` configuration cannot represent the build Worker’s Artifacts push-event triggers. Fly commands must target the `contextlayer` organization: pass `--org contextlayer` where supported, and verify with `fly orgs list` or the app's `fly status` before any mutation. Do not create an app as a side effect. Keep Fly deployments to one machine (`--ha=false` when creating machines); changes beyond a plain deploy require discussion with the user. These conventions do not imply that this repo currently owns a running Fly app.

## Sentry

Sentry org `803-inc` owns the reporting projects; `sentry project list` is the live inventory. Shared retains the tested Sentry event-cap helper. There is no application telemetry host in this workspace. Use the retained Sentry skills for CLI operations, error triage, and instrumentation; they do not authorize changing the remote service.

When interpreting telemetry, sampling means counts are not traffic rates; span start order does not establish dependencies, and overlapping spans must not be summed as elapsed user wait. Attribute subprocess spans by working directory, not just command name. For streamed responses, HTTP 200 alone does not prove a successful render.

## Troubleshooting

The user permits pnpm to rebuild `node_modules` when installation requires it. In a non-interactive shell, use `CI=true` to accept that operation.

Run commands directly (`pnpm`, `npx`, `node`); do not prefix them with `mise exec`. Mise provides the installed tool versions through the shell environment. If a command reports a runtime or version error, stop and ask before changing the environment or invocation. Keep the enforced version floor.

Run a failing Turbo task alone to read its output. Shared-machine cleanup requires exact ownership: stop only your own PIDs and reclaim only your own databases. Report resources of uncertain ownership and ask before removing them.

### Dashboard user-menu verification

With web on localhost:3000 and platform on localhost:3030 using the local auth issuer, open the dashboard’s account menu. Existing web device sessions should be listed; switching accounts should update the user and navigate to Personal, loading that user’s app list even when the previous page belonged to an organization. Add account opens web sign-in with the dashboard return URL. Sign out revokes the session through web and returns to sign-in. Web’s credentialed CORS configuration is required for these direct browser calls. The user-menu slice and Settings navigation have been accepted locally. The account-switch-to-Personal correction and web CORS configuration are deployed; verify the complete account-switch workflow through the browser.

The workspace switcher beside the user menu navigates between `/dashboard/personal/apps` and `/dashboard/org/<slug>/apps`. It reads choices directly from web, and the server resolves the chosen slug through web before querying apps by organization ID. Open `/dashboard` to start in Personal. Verify the selected workspace name, navigate between workspaces, and refresh the organization URL. Personal and organizations use the same text-only layout and row spacing; the workspace menu has no settings actions. The shared empty state shows `ctx init my-app` for Personal and `ctx init --org <selected-slug> my-app` for organizations. The CLI option and organization-owned creation are implemented; testing them locally requires a CLI login issued by the same local web server used by platform. The web organization-record response and platform readers must deploy together before using this against production. User-menu and Settings navigation have been accepted locally; workspace-switcher browser acceptance is pending.

The app-list API supports `GET /api/apps?owner_user_id=<user-id>` or `GET /api/apps?owner_organization_id=<org-id>`; omit the filter for all manageable apps. Supplying both returns a validation error. Filters select candidates and do not grant authorization. The former overloaded `owner` query is removed.

## Polar sandbox webhook and access verification

Use sandbox credentials for development. Apply migration 005 with the normal platform database command, then initialize existing owners using Polar’s native Customer State API and the shared `saveCustomerState` operation (null event timestamp for API seeds). Configure a sandbox endpoint for only `customer.state_changed`, API version `2026-10`, pointing directly to platform’s `/api/polar/webhooks`. Put that endpoint’s signing secret in Doppler `platform/dev`. The subscription access check reads saved database state; actual usage ingestion additionally requires the sandbox API token and `POLAR_ENVIRONMENT=sandbox` in Doppler `platform/dev`. Missing or empty state blocks runtime viewing and tool execution with 402; `/slate.json` and connection configuration remain available under ordinary authorization.

For local webhook delivery, expose the platform port through ngrok. A native traffic policy can restrict delivery to POST `/api/polar/webhooks`; Vite also requires an allowed host or ngrok host-header rewriting. Retarget the sandbox endpoint whenever the tunnel URL changes. Verify a real Polar delivery returns 204 and updates the stored state; unsigned delivery returns 403. Keep sandbox and production endpoints, secrets and databases separate.

The billing integration test starts the real built platform Worker with real sandbox Customer State and a disposable migrated Postgres database. Supply `POLAR_ENVIRONMENT=sandbox`, `POLAR_ACCESS_TOKEN`, `CTX_TEST_USER_ID` and `CTX_TEST_ORGANIZATION_ID` for an existing subscribed individual/team pair, plus the normal platform environment and a current `CTX_TEST_ACCESS_TOKEN` for that user issued by `CTX_AUTH_ISSUER`. The user must belong to that organization: local manifest configuration exercises the production membership check. It tests owner attribution, runtime/tool gating, anonymous public viewing, manifest authorization and connection configuration, then stops its Worker and drops its database. These billing checks read Polar and web without performing provider writes:

```sh
doppler run -p platform -c dev -- pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- billing.node.integration.test.ts ownership.node.integration.test.ts
```

Before deploying billing access, configure the production platform signing secret in Doppler `platform/prod`, migrate production, initialize existing owners from production Polar and register the production endpoint. Deploy platform and dispatcher together because resolution now requires `pathname`. Sandbox verification alone does not perform these production steps; Doppler mutations remain user-owned.

## App usage verification

Dispatcher and platform require `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` through their package-local `env.ts`. Use a sandbox token for local verification. Resolution returns `{ id, owner }`; deploy platform and dispatcher together. Before pushing this change to main, configure the production token and `POLAR_ENVIRONMENT=production` in Doppler `platform/prod`, and set dispatcher’s Cloudflare Workers Builds deploy command to `bash packages/platform/scripts/deploy-cloudflare.sh dispatcher`. The shared deployment script defaults to platform; dispatcher receives only those two Polar values. These external configuration changes remain user-owned and are not performed by editing the deployment script.

Shared unit tests call the production response classifier to verify recognised dynamic responses, all mutation verbs, redirects and free asset/manifest media types; dispatcher tests call the production request handler to verify responses return while the shared ingestion operation remains pending. These tests run in the ordinary unit tier and CI without provider credentials. They do not run a framework-built React Router app. Response classification is deliberately best-effort: app-controlled headers can influence eligibility, including static text/JSON responses being indistinguishable from dynamic ones. Trusted Workers own the clip weights and owner attribution. The usage integration test uses native Polar SDK ingestion and real sandbox customer state/meters, with isolated Postgres. Supply the same subscribed individual/team fixture IDs as the billing test. It writes three events totaling five clips per customer; obtain approval for those exact sandbox writes before running it. Composio execution is supplied at our own `callTool` operation boundary, so this test verifies metering without executing a third-party tool. Its ephemeral database is dropped afterward; Polar usage events are immutable and remain as sandbox evidence.

```sh
doppler run -p platform -c dev -- pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- usage.node.integration.test.ts billing.node.integration.test.ts ownership.node.integration.test.ts
```

## Chrome development

The platform iframe reads its own native-session profile and connection data. Authored apps have only the Tools runtime capability. Install matching locally packed CLI and SDK when verifying unpublished changes. Existing apps must change `workers/local-tools/index.ts` to export only `Tools` from `@usecontextlayer/sdk/local` and remove imports of `viewerContext` and `connectionsContext`.

When installing unpublished CLI and SDK tarballs in a demo, installing the CLI as a direct file dependency does not force the SDK's transitive CLI dependency to use it. Add a native pnpm override in the demo's pnpm-workspace.yaml so both resolve to the local CLI tarball, then run pnpm install and restart the app's dev server. This belongs only in the temporary unpublished-package setup; published matching versions resolve normally.

```yaml
overrides:
  '@usecontextlayer/cli': 'file:/absolute/path/to/local-cli.tgz'
```

## Verifying the app-connection read

The platform frame renders the current browser user and the app’s requirement/assignment rows. Its connected-services section toggles the existing inline JSON tray. The app root no longer exports a chrome loader. For local development, use the intended CTX_PLATFORM_URL and the same auth issuer/client as the saved CLI login for runtime Tools. The frame authenticates automatically with the native web session; it has no separate popup or frame cookie. Native session cookies are Secure, HttpOnly, and SameSite=None in every environment. Cross-site authentication requires the browser to permit that cookie; these attributes do not override third-party-cookie blocking. The frame receives the app ID and manifest startup snapshot from the existing Vite integration. General APIs continue rejecting the viewer cookie.

CLI startup validates public/slate.json once; Tools receives that parsed snapshot in its service-binding props, and Layout receives the same non-secret snapshot for the frame. Editing requirements requires restarting development. Saved assignments appear on the next platform-frame load without restarting. There are no local or hosted Viewer/Connections entrypoints.

## Iframe chrome verification

The frame lives at `/dashboard/chrome/apps/:target` on platform's existing router. The native identity middleware verifies web's session for both the frame and dashboard. The frame permits anonymous rendering; protected dashboard routes retain their authentication gate. Better Auth remains the session authority, and web logout revokes subsequent frame authentication. There is no popup, token exchange action, or separate frame cookie. No migration or additional secret is required.

Run `pnpm exec turbo run tsc test build --filter=@usecontextlayer/platform... --filter=@usecontextlayer/sdk... --concurrency=4`. In the matching web checkout, run `doppler run -p web -c dev_personal -- pnpm test --project integration lib/__tests__/viewer-session.integration.test.ts lib/__tests__/platform-identity.integration.test.ts lib/__tests__/trusted-origins.integration.test.ts` after verifying the Doppler workplace. The existing real Better Auth tests check native session cookie attributes, logout revocation, origin rejection, and general API rejection of viewer cookies.

Browser verification must use HTTPS on different sites for app and frame, with third-party cookies permitted; localhost ports alone do not reproduce production cookie delivery. Sign in on web, then load the app with no extra sign-in interaction. Check the native profile, saved assignments, tray resize, authenticated reload, and logout revocation. Confirm the authored parent cannot read the frame DOM and receives only presentation messages. Check that the frame CSP permits intended app subdomains and blocks unrelated embedding. A same-origin dashboard form should succeed; a credentialed cross-site form submission should return 403 through Hono's CSRF middleware. Secure cookies remain required during development, so use a browser-supported secure localhost context or HTTPS rather than changing cookie attributes.

React Router’s /dashboard/__manifest serves public route metadata and bypasses the native dashboard cookie gate, like static assets. This keeps native route discovery available inside a cross-site frame; it does not grant access to route loaders or general APIs.
