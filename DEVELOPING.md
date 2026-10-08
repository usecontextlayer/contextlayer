# Developing

See @DOCS.md for which document owns what. This file carries setup, commands, prerequisites, local development, testing, migrations and operational workflows; evidence and status go in the ExecPlan, concepts in ARCHITECTURE.md.

Use the root package scripts and Turbo for libraries and applications. Main pushes run checks; version-tag pushes publish npm packages.

## Setup

The dashboard uses the private Font Awesome npm kit described in [`.font-awesome.md`](.font-awesome.md). The repository maps its npm scopes in `.npmrc`; configure the Font Awesome package token in your user npm configuration before installing dependencies. Never commit that token.

Run from the repository root:

```sh
mise trust
mise install
pnpm install --frozen-lockfile
```

The root `.node-version` pins Node for Cloudflare builds, local development, and GitHub Actions. `mise.toml` reads that file and provides Node and pnpm; the pnpm version must match `package.json`. Corepack stays unused. `pnpm-workspace.yaml` enforces the Node version floor and disables automatic dependency repair during task execution, so install dependencies explicitly before running tasks.

## Workspace commands

```sh
pnpm run check
pnpm run format.verify
pnpm run tsc
pnpm test
pnpm run build
```

`check` runs workspace-reference and Tailwind checks, fixes formatting, and typechecks. `format.verify` checks without editing files. The Tailwind checker discovers stylesheet entry points across `packages/`; it reports explicitly when there are no Tailwind stylesheets to scan. The root Tailwind deprecation checker owns its compiler and scanner as development dependencies.

For package-scoped work, use Turbo selectors:

```sh
pnpm exec turbo run build tsc --filter=@usecontextlayer/shared...
pnpm exec turbo run test --filter=@usecontextlayer/shared...
pnpm exec turbo run dev:watch --filter=@usecontextlayer/db-infra...
```

A library carries `dev:watch` for rebuilding its output. The general task convention remains: a server's `dev` starts it, `dev:watch` adds watching, and a package defines only the forms it actually uses. Turbo owns dependency builds through `^build`.

## CLI development

The `ctx login` / `ctx whoami` flow requires web's migrated OAuth device extension and a public CLI client linked to the platform resource. The ordinary CLI defaults to the production issuer, client ID and platform URL; use the [connected development procedure](#platform-development) for local work. Only localhost/127.0.0.1 issuers permit HTTP in the CLI. Credentials are written to `~/.contextlayer/auth.json` with owner-only permissions on creation. The `@usecontextlayer/cli/auth` export contains only `getAccessToken`, `getCurrentUser`, `listOrganizations`, `LoginRequiredError` and the `AuthEnv` type; interactive login remains a CLI command.

Build the local `ctx` executable, then invoke it from the repository root:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/cli
pnpm ctx --version
pnpm ctx init my-react-router-app
```

Run the built CLI's `ctx login` to register its credential helper for this OS user. Registration points Git at the executable used for login; run login again if that installation moves. Git needs native `authtype` credential support. Login and init must target the same platform URL so Git's registered URL scope matches the remote.

Create test projects outside this checkout. Create Cloudflare reuses an enclosing Git repository instead of initializing a nested one, so testing inside this repo prevents the generated project from having its own Git root and origin. The pnpm executable must also work from the generated project's directory; a machine-wide mise default supplies it outside repo-local tool configuration, without `mise exec` or a CLI workaround.

`ctx init <directory>` uses the official Cloudflare React Router scaffold through `pnpm create cloudflare@latest`, accepting defaults, initializing Git, and disabling deployment. The generated project owns its `pnpm dev` and `pnpm build` commands. `CTX_PLATFORM_URL` is read in the CLI's `env.ts` and defaults to `https://slate.usecontextlayer.com`. Initialization does not push. Relative directories resolve from the calling directory. The version comes from `packages/cli/package.json`. Run `pnpm exec turbo run dev:watch --filter=@usecontextlayer/cli` to rebuild the CLI as its source changes.

## OAuth registration and migration

Follow the [resource and scope contract](ARCHITECTURE.md#oauth-resources-and-scopes). Keep the issuer, client registration and all consumers in the same environment; local initialization must use local web.

Do not add an environment registry, hostname pool or platform-resource setting. Use the [connected development procedure](#platform-development) for local setup.

For a new environment, register resources and the public CLI client through Better Auth's native operations, link the client to the platform resource, and allow the device-code and refresh-token grants with `platform:access` and `offline_access`. Let normal CLI device login and MCP authorization issue credentials.

For an existing environment, inspect native resource registrations, client scopes and client-resource links before proposing changes. Coordinate caller/verifier changes with registration updates, including resource `allowedScopes`, while preserving `offline_access`; source edits do not migrate registrations or saved grants. Re-run CLI login and MCP authorization after migration. Remote configuration changes follow the operator approval workflow. Production app provisioning requires the same `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `platform/prod` and `web/prod`; see [Releases and deployment](#releases-and-deployment).

## Platform viewer authentication

Runtime viewer authentication checks the copied session through web's /api/auth/get-session using the bearer plugin.

For native browser session development, follow [Platform development](#platform-development), then open the printed platform dashboard URL with the baseline web session.

To check the dashboard sign-in redirect with curl, send `Accept: text/html`; curl's default wildcard header receives 401. Web’s default platform address is `https://slate.usecontextlayer.com`.

`auth.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), including running web/viewer services and the saved baseline CLI login. It checks viewer-cookie restrictions, native-session origin requirements, CLI access, scoped resource inputs and public declarations through an isolated platform database and Worker; missing billing state deliberately stops authenticated execution at 402. It creates and revokes native web/viewer sessions and writes isolated SQL rows, without app provisioning, vault writes or provider execution. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- auth.node.integration.test.ts`. This exercises the HTTP handoff and platform boundaries; the combined app/chrome visitor experience requires app push and deployment.

Browser form fixtures must send the same-origin Origin or Sec-Fetch-Site metadata that browsers supply. JSON fixtures must carry application/json.

`mcp.node.integration.test.ts` needs the [connected test prerequisites](#platform-development) and the dispatcher build. It checks MCP metadata, cookie rejection, app-bound authorization, cross-app/management rejection and native viewer access using local web consent and PKCE exchange. The authentication case creates an app, its remote test Artifacts repository, and local web OAuth registrations/grants; fixture cleanup removes the repository and signs out the web session. Run only that case with `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- mcp.node.integration.test.ts --testNamePattern 'bind MCP'`.

The complete MCP file additionally needs the baseline personal Free entitlement from [Platform development](#platform-development). It builds an authored echo app through the SDK, runs a native MCP client against the platform/dispatcher fixtures, and checks discovery, View delivery, tool execution and usage. It deploys a disposable Worker to `contextlayer-test` and writes a Sandbox usage event for the successful echo call; discovery, resource reads and invalid arguments must add no usage. The test body deletes its deployed Worker before fixture teardown, and the app fixture deletes its Artifacts repository; local web OAuth registrations remain because no app-deletion operation removes them. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- mcp.node.integration.test.ts`.

## App ownership

Run `ctx login` before `ctx init`. See `ctx init --help` for organization selection.

Migration 003 requires every existing app to have an owner. Resolve existing rows before running it; there is no automatic backfill or deletion in the migration. Production migrations run separately from the main-push deployment pipeline.

Migration 004 adds non-null text `app.visibility` and backfills existing apps to `private`. Apply migration 004 before starting platform against an existing database.

Apply migration `007_app_member` before using app membership against an existing database. Sign in with `ctx login` before explicit joining; the built CLI's `join --help` owns target syntax.

## Local app tools

Local CLI configuration uses only the current folder's public/slate.json and agents/{name}/slate.json, ignored .contextlayer/connections.json bindings, exact-name secret environment variables, and generated .contextlayer/folders/{slug} directories. Listing does not require Git metadata, a login, a running development server, or a platform request. The CLI adds /.contextlayer/ to the app's .gitignore while preserving existing content. Use the commands' --help for selection and assignment syntax. For a live smoke check, call a read-only tool through an authored route and verify its observable response. React Router index actions require the native `?index` query parameter on direct POST requests, as framework Form submissions supply.

Run the generated app's `pnpm dev` command for local tools. Development-startup inputs require restarting pnpm dev after declaration/configuration changes.

[The SDK README](packages/sdk/README.md) documents the loader API and Gmail example. [Architecture](ARCHITECTURE.md) owns the connection-slug contract and runtime boundaries. When verifying unpublished source, install locally packed CLI and SDK packages in the generated app.

## Resource Owner selection verification

The [auth integration suite](#platform-viewer-authentication) exercises personal-account authentication boundaries using connected baseline web, the saved CLI login and isolated platform SQL.

Migration 006 preserves existing connection assignments as user Owners and enables organization Owner assignments. Apply it to an existing database before deploying platform, and update app manifests from `individual`/`shared` to `viewer`/`owner`.

`connection-owner.node.integration.test.ts` needs only [shared Postgres](#tests-and-local-postgres). It exercises the production migration, listing, assignment, execution resolution and agent preparation against isolated databases, checking preserved assignments and viewer/app-owner selection. It writes only its disposable SQL state, with no web, CLI login, Doppler, Composio or vault prerequisite. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- connection-owner.node.integration.test.ts
```

`app-resources.node.integration.test.ts` needs the [connected test prerequisites](#platform-development). It drives the app-creation API, Git and CLI to check pushed app/agent configuration independently of local declarations and bindings, including rejection of caller-supplied Resources. It creates and deletes remote test Artifacts repositories, leaves app OAuth registrations in local web, and writes isolated SQL assignments and temporary Git files; it performs no connected-provider execution or vault write. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- app-resources.node.integration.test.ts`.

`agents.test.ts` verifies personal/organization Owner selection with a distinct acting user, without fake Artifacts, web, or Doppler. Run through `pnpm exec turbo run test --filter=@usecontextlayer/platform`. See [Publishing and inspecting an agent](#publishing-and-inspecting-an-agent) for the Git publication integration.

Local agent jobs additionally require Docker running for Wrangler’s native attached containers and the one-off shared repository `agent-shared-2026-10-05-91fc24d8` seeded on `main` in the configured Artifacts namespace.

A live job proof needs published agent instructions and agents/{name}/slate.json declaring `ANTHROPIC_API_KEY` in Artifacts, a valid public/slate.json using the same schema, and the selected Owner’s key in the configured development Doppler vault. Service-tool jobs also need connection requirements in their own agent Slate and their Owner's existing accounts assigned through the app connection API. Drive the actual built Worker with Wrangler’s native test harness and production HTTP endpoints; capture model behavior as observational evidence instead of asserting exact output or tool ordering. Keep Artifacts reads inside workerd: direct Node-proxy preparation cannot preserve its disposable repository handle (`Object not disposable`). Native `harness.update(current => current)` reloads the Worker while retaining SQLite, after which HTTP inspection can verify persisted status/result. Reacquire native bindings through `worker.getEnv()` after reload if the driver needs them for cleanup. The native harness and disposable fixture/database must own cleanup.

## Platform development

Run the connected environment from this repository with Node and workspace dependencies installed as in [Setup](#setup), the sibling `../web` checkout installed and built, Docker running, and Wrangler authenticated for the remote `contextlayer-test` resources. Doppler must resolve to the ContextLayer workplace in both checkout directories: check `doppler me` in each before use, because web's configuration is read with `../web` as the working directory. The `@polar-sh/cli` install script, allowed by `pnpm-workspace.yaml`, must have unpacked its native `polar` binary during `pnpm install`.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Initialize and start local web, platform, viewer auth, dispatcher and Polar Sandbox forwarding. Keep it running while developing or running connected tests. |
| `pnpm dev:ctx <args>` | Run the built CLI with the selected local platform URL, web issuer and initialized public CLI client. |
| `pnpm dev:env` | Print shell-safe connection settings for an arbitrary command in a subshell. |

Select service addresses only when a default port collides. Use complete HTTP localhost URLs with explicit ports, keeping web and platform on the same hostname for browser cookies.

| Setting | Default |
| --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:3000` |
| `CTX_PLATFORM_URL` | `http://localhost:3010` |
| `CTX_VIEWER_AUTH_URL` | `http://localhost:3011` |
| `CTX_DISPATCHER_URL` | `http://localhost:3012` |

Export any startup overrides with the same values in every other terminal running `dev:ctx`, `dev:env` or integration tests; another terminal does not inherit variables passed only to the startup process. The same rule applies to selected database URLs and Polar overrides. `CTX_PLATFORM_DATABASE_URL` defaults to `postgresql://postgres:postgres@127.0.0.1:6489/contextlayer_platform`; web's `DATABASE_URL` defaults to `postgresql://postgres:postgres@127.0.0.1:5489/contextlayer_web`.

`pnpm dev` builds workspace dependencies through Turbo, reads Doppler `platform/dev` and `web/dev_personal`, starts both checkouts' Compose Postgres services without recreating running containers, creates the selected logical databases if absent, and runs each application's migrations. It starts native Next.js, React Router/Vite and Wrangler development for web, platform, viewer auth and dispatcher; the Workers select Cloudflare `test`. Once the services listen, it starts the Polar listener and invokes web's baseline initializer. Credit grants arrive asynchronously. Repeated initialization reuses the baseline user, organization and public CLI client. The organization slug `local-development` and client name `ContextLayer Development CLI` are hardcoded constants.

Doppler `platform/dev` supplies provider credentials, including `COMPOSIO_API_KEY` and Sandbox Polar credentials. `readPolarEnv` reads `POLAR_FREE_PRODUCT_ID` from that config with the invoking environment overriding it; the same precedence applies to `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT`, which must be `sandbox`. The composition supplies the selected Polar token/environment to web, platform and dispatcher. It derives `CTX_AUTH_ISSUER` from the web URL, selects `CTX_PLATFORM_DATABASE_URL` from the parsed addresses, discovers `POLAR_CLIPS_METER_ID` through the Free product's meter-credit benefit, and obtains `POLAR_WEBHOOK_SECRET` from the Polar CLI. These values do not need to be stored in `platform/dev`; no tunnel or manual issuer configuration is needed.

App provisioning requires `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `web/dev`, inherited by `web/dev_personal`; connected setup passes that one value to local web and platform. A provisioning failure rolls back SQL but can leave the Artifacts repository. Do not maintain a second local secret copy in `platform/dev` or point local provisioning at production web.

Use your regular browser at the printed web URL, signed in as the baseline `CTX_DEV_USER_EMAIL` (`local-dev@usecontextlayer.com`); the email/password inputs live in Doppler `web/dev` and are inherited by `web/dev_personal`. Sign out of any other localhost account before opening a CLI device link. In another terminal, run `pnpm dev:ctx login` and approve its device request in that same browser, then run `pnpm dev:ctx whoami`. Keep that browser session for development and ordinary CLI approvals. Better Auth binds a device code to the first signed-in user who opens it; if another account claimed it, switch accounts and start a fresh login. Open the printed platform dashboard URL for browser development.

After initialization, `dev:ctx` and `dev:env` read the existing public client registration through web's development entry point. This configuration lookup does not start services or issue credentials; `dev:ctx` then runs the requested CLI command. Ordinary `pnpm ctx` retains its normal environment and production defaults. `dev:env` exports the four service URLs, `CTX_PLATFORM_DATABASE_URL`, `DATABASE_URL`, `CTX_AUTH_ISSUER` and `CTX_AUTH_CLIENT_ID`. It does not export access tokens, baseline credentials, Polar overrides or the applications' Doppler secret sets.

`dev:env` writes shell assignments to stdout and leaves command banners and diagnostics on stderr. Use its output directly with `eval`, without `--silent`, in a subshell so the parent shell stays unchanged:

```sh
(eval "$(pnpm dev:env)" && python my-script.py)
```

Connected platform integration suites use this running environment and the saved baseline CLI login. Build platform and CLI before running them; MCP and usage also need the dispatcher build:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/platform --filter=@usecontextlayer/cli --filter=@usecontextlayer/dispatcher
```

Shared fixtures read Doppler themselves, so invoke test commands directly without a `doppler run` wrapper. They select the native web session and sign it out, read the saved CLI identity and baseline organization membership, and share service configuration. Tests select an isolated platform database, platform Worker, dispatcher Worker and temporary directory as needed; the CLI environment targets the selected platform Worker. The Free-enrollment suite selects the running development database and platform instead. See [Tests and local Postgres](#tests-and-local-postgres) for fixture selection and cleanup, and each suite's section for external writes.

Apps created by `ctx init` start on `main`. Initialization requires the saved login and Git author identity before scaffolding or app registration. Missing or rejected login receives the shared `ctx login` guidance; Git's own error output supplies missing-identity configuration instructions.

Wrangler’s native `secrets.required` declaration imports process configuration into Worker bindings; do not maintain a `.dev.vars` copy. `CTX_APPS_DOMAIN` defaults to `contextlayer.xyz`. The default `ARTIFACTS` and `APPS` bindings select `contextlayer-prod`; connected startup and integration harnesses select native `test` bindings using remote `contextlayer-test` repositories and user Workers.

The platform package's `dev:watch` uses Cloudflare Vite with the source entrypoint, while its `dev` uses Wrangler with the compiled bundle and source Wrangler configuration. Both select `test` and run in workerd, defaulting to port 3010. Vite preview uses the bindings selected at build time; changing `CLOUDFLARE_ENV` only at preview startup does not select another namespace. There is no Node production server or `CTX_PLATFORM_PORT` setting.

Connected startup migrates without regenerating source. To migrate and regenerate Kanel types against the same selected platform database, use the initialized command environment:

```sh
(eval "$(pnpm dev:env)" && pnpm exec turbo run db.latest --filter=@usecontextlayer/platform)
```

The migration command reads `CTX_PLATFORM_DATABASE_URL` and passes that URL to Kanel as its child-process `DATABASE_URL`. A bare `doppler run -p platform -c dev -- …` selects Doppler's database URL, which need not match connected startup's parsed default or override.

The local server prints its root URL; open `/dashboard/personal/apps` for the dashboard. Changing Vite's base to `/dashboard/` would put its modules inside the dashboard authentication/routing gate.

Run `pnpm dev:ctx init <directory>` against the connected local environment, then push the project's commit with `git push origin HEAD:main`. The app appears at `/dashboard/personal/apps` immediately after initialization. `/api/openapi.json` describes creation, listing, hostname resolution, and visibility updates.

`platform.node.integration.test.ts` needs the connected test prerequisites above. It exercises personal/organization app creation, creator membership, private joining, visibility, listing, dashboard rendering, agent publication and Git push/clone/pull through the API and built CLI. It creates and deletes remote test Artifacts repositories and leaves app OAuth registrations in local web; its SQL, files and Git configuration are isolated and reclaimed by the fixtures. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- platform.node.integration.test.ts
```

`ownership.node.integration.test.ts` needs only [shared Postgres](#tests-and-local-postgres), without the connected services or CLI login. It checks that each app has exactly one user or organization owner and writes only disposable SQL rows. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- ownership.node.integration.test.ts`.

## Shared secret management verification

Use the [connected test prerequisites](#platform-development) for Owner-owned secret management. The built CLI's `secrets --help`, `secrets set --help`, and `secrets drop --help` own input and Owner-selection syntax. Doppler `platform/dev` supplies `CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT=customer-credentials-local`, `CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG=prod`, and a read/write service token scoped to that vault as `CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN`. Production `platform/prod` supplies the corresponding settings for `customer-credentials/prod`. Platform declares these runtime secrets; dispatcher does not. Provisioning or changing Doppler tokens/config/secrets remains user-owned. Without the vault token, unrelated platform routes still work and authorized secret operations fail loudly.

The non-writing cases in `secrets.node.integration.test.ts` need the [connected test prerequisites](#platform-development) and Composio configuration, but no vault token. They exercise anonymous/other-Owner denial, OpenAPI discovery, stdin guidance, organization selection and real personal/organization connection listing through the API and CLI. They make no vault writes and create no Composio accounts or authorization links. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- secrets.node.integration.test.ts --testNamePattern non-writing
```

The live Doppler case additionally needs the vault's config-scoped token and user authorization for each write, naming the exact Owner/key and vault destination before execution. It checks stdin preservation, replacement, Owner isolation, deletion and the absence of values/credentials in output, using a generated `CTX_SECRET_E2E_` name for the baseline user and organization. It creates a personal secret through CLI stdin, creates an organization secret with the same name through CLI stdin, replaces the personal value through PUT, replaces the organization value through CLI stdin, then drops the personal secret through CLI and the organization secret through DELETE. These writes target the configured vault, normally `customer-credentials-local/prod`; provider reads check the raw values without printing them. A failed run can leave test secrets present; inspect and agree cleanup before any further write. After authorization covers each write, run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- secrets.node.integration.test.ts
```

Do not automate Clack's terminal renderer or add pseudo-terminal plumbing to this suite.

## Publishing and inspecting an agent

Add `agents/<name>/instructions.md` to an app project and push through its normal `/git/<app-id>` remote. See [Authored agents](ARCHITECTURE.md#authored-agents) for inspection, authorization, and revision semantics.

Publish schedules as `agents/<name>/schedules/<prompt>.md` with YAML frontmatter such as `cron: "0 7 * * 1-5"` and the user prompt in the Markdown body. Cron is canonical five-field UTC.

`platform.node.integration.test.ts` needs the [connected test prerequisites](#platform-development). It checks published instructions and their commit before and after a Git push, alongside source-access authorization. It writes and deletes its remote test Artifacts repositories, leaves app OAuth registrations in local web, and reclaims its isolated database and temporary Git files. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- platform.node.integration.test.ts
```

## Running an agent locally

Build the CLI with `pnpm exec turbo run build tsc --filter=@usecontextlayer/cli`. From an app root containing `agents/<name>/instructions.md`, use `ctx agent --help` for the local-run command. When verifying unpublished source from another directory, invoke the checkout's built `packages/cli/dist/cli.mjs` with Node using its absolute path. Claude Agent SDK uses native Claude authentication, so an existing Claude login or SDK-supported model credential must be available. No ContextLayer server or login is involved.

See [Authored agents](ARCHITECTURE.md#authored-agents) for local instruction composition and settings isolation. Verify instruction behavior with a real local task and record model output as observational evidence.

## Build Worker

Build and typecheck `packages/build` from the repository root with `pnpm exec turbo run build tsc --filter=@usecontextlayer/build`. Building the configured Sandbox image requires Docker. Deployment of the build Worker itself uses the shared repository-root workflow described under [Releases and deployment](#releases-and-deployment).

The `contextlayer-build-backups` R2 bucket stores SDK workspace snapshots. Manage bucket-scoped Object Read & Write credentials as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the authored-app Workers deployment API token as `CF_TOKEN`, centrally in Doppler `platform/prod`. Declare those three runtime secrets in the build Worker's native `secrets.required`; the shared deployment workflow supplies them through Wrangler without a `.dev.vars` copy. Platform must export the named `Publication` entrypoint before deploying the build Worker that calls it, and its production Artifacts namespace, dispatch namespace, and R2 bucket must exist before publication runs.

Push a project created by `ctx init` through the running platform’s Git endpoint. In the Cloudflare dashboard, open Workflows → `contextlayer-build` and inspect the new instance’s `build` step. Its command output and status show whether the pushed commit built; a successful result includes the SDK’s workspace snapshot. Cloudflare account access is required to inspect these runs. Inspect both the `build` and `deploy` steps to confirm deployment. To update a scheduled agent, keep public/slate.json and every agents/<name>/slate.json valid, commit its schedules/<prompt>.md with canonical five-field UTC cron frontmatter and a Markdown user prompt, and push normally.

## Dispatch Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/dispatcher`. Deploy through the shared repository-root workflow described under [Releases and deployment](#releases-and-deployment). The `contextlayer-prod` WfP namespace must exist before deployment.

The wildcard DNS record for `*.contextlayer.xyz` is proxied. Wrangler attaches that route to `contextlayer-dispatcher`. The dispatcher’s `CTX_PLATFORM_URL` is `https://slate.usecontextlayer.com`. App routing uses the deployed platform and Neon database; no local server or tunnel is required.

## Viewer auth Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/auth --filter=@usecontextlayer/dispatcher`. Auth uses Wrangler on `auth.contextlayer.xyz/*`, more specific than dispatcher's wildcard, and follows the same shared repository-root deployment workflow as the other Workers. Web must expose `/viewer/sign-in` and enable Better Auth's one-time-token and bearer plugins before deploying these Workers.

Auth's `CTX_AUTH_ISSUER` defaults to `https://www.usecontextlayer.com/api/auth`; dispatcher uses `CTX_VIEWER_AUTH_URL`, defaulting to `https://auth.contextlayer.xyz`, and auth uses `CTX_APPS_DOMAIN`, defaulting to `contextlayer.xyz`. Web's `CTX_VIEWER_AUTH_URL` fixes the allowed callback destination. Verify that logging out on web makes the next private app request require sign-in and public apps remain anonymously viewable.

## Tests and local Postgres

`pnpm test` runs the unit tier. `AGENTS.md` and `vitest.shared.ts` define the Node/browser runtimes and node/browser/Claude integration tiers. CI runs unit tests; integration tests are opt-in. Node unit suites run in cli, shared, and platform; Node integration suites run in dev-env (Postgres) and platform (Cloudflare Artifacts, Polar sandbox and Postgres). Dispatcher behavior runs through platform’s native usage and MCP integrations.

Platform and web integration tests provision isolated databases on the server selected by `CTX_PLATFORM_DATABASE_URL`, defaulting to Compose Postgres on `127.0.0.1:6489`; see [Platform development](#platform-development) for address selection. Web's persistent development database on port 5489 is separate and stays untouched by these tests. If the shared Compose server is not running, start it once:

```sh
docker compose up -d postgres
```

`packages/dev-env/__tests__/ephemeral.node.integration.test.ts` needs only that Postgres server. It checks database provisioning, caller-supplied migrations, failure cleanup and concurrent isolation. It creates and drops uniquely named databases on the selected server and makes no cloud/provider writes. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/dev-env -- ephemeral.node.integration.test.ts
```

Do not stop, restart or reset the shared Postgres instance. Reclaim only databases your session created; report suspected leftovers and ask before cleaning up another session's resources. An interrupted test can leave databases behind, so a prefix alone never proves a database is safe to delete.

The root commands `test:integration:node`, `test:integration:browser`, and `test:integration:claude` select individual tiers. `test:integration` requests all three.

Platform suites select prerequisites through the exported Vitest `test` objects in `packages/platform/__tests__/database.ts` and `packages/platform/__tests__/integration.ts`. The database-only object lazily selects file-scoped addresses, a migrated per-test database and its connection. The connected object extends it with file-scoped web/service configuration, command settings, saved CLI identity and baseline organization; its native web session, temporary directory, development-database connection, isolated platform configuration, platform/dispatcher harnesses and CLI environment are per-test fixtures. Destructured dependencies select only the capabilities a test needs. Fixtures register owned-resource teardown with `onCleanup`; SQL-only suites therefore acquire no web session, saved login or provider configuration.

Worker fixtures use Wrangler's native `createTestHarness()` with `env: "test"` and `prebuiltWorkerDir` pointing to platform's normal `build/server` bundle or dispatcher's `dist` output. Follow [Platform development](#platform-development) for builds and prerequisites. Fixtures supply native `secrets`, call `listen()` and register `close()` with `onCleanup`; Wrangler owns ports, readiness, runtime resources and container preparation. Docker is required by platform's container configuration. Use `getLogs()` for captured Worker logs. Platform's integration config retains a five-minute hook timeout and a normal 90-second test timeout; scenarios can declare a longer test timeout.

Register scenario cleanup with `await using` and `AsyncDisposableStack` inside the body, so Artifacts repositories and deployed Workers are deleted while the Worker fixture is alive: Vitest tears down test-scoped fixtures before `onTestFinished`. Reclaim repositories through the same configured `ARTIFACTS` binding used for creation, obtained with `worker.getEnv()`. Fixture-owned resources can use dependent `onCleanup` lifetimes, as the MCP app fixture does. Keep the operation under test in the body.

## Releases and deployment

The production platform URL is `https://slate.usecontextlayer.com`. Production database configuration belongs in Doppler `platform/prod`; Neon's `platform` project owns the production database. Configure native Cloudflare Workers Builds for platform, dispatcher, auth, and build against `main` in `usecontextlayer/contextlayer`, with repository root `/`. Every Worker uses the same root script, with only its package argument changing:

```sh
bash scripts/cloudflare.sh build <package>
bash scripts/cloudflare.sh deploy <package>
```

Use `platform`, `dispatcher`, `auth`, or `build` as `<package>`. Workers Builds reads the repository-root `.node-version`; remove any separate `NODE_VERSION` build override. Set `PNPM_VERSION=11.22.0`, `SKIP_DEPENDENCY_INSTALL=true`, and `WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST=1` in each Workers Builds configuration. Registry authentication must be available before installation. Wrangler's native CI setting lets Docker image build steps use the runner's host network; Turbo's build task passes that exact variable through its strict environment filter.

Supply a config-scoped read-only service token for Doppler `platform/prod` as the Cloudflare build secret `DOPPLER_TOKEN`. Use the credential returned when creating the token; subsequent token listing/get calls return metadata without its value. The shared build phase installs the official Doppler CLI, obtains `FONTAWESOME_PACKAGE_TOKEN` through `scripts/ci.npmrc`, installs workspace dependencies, and runs the selected package's existing Turbo build. The deploy phase reads the effective Wrangler configuration, including Vite's generated configuration, obtains only its native `secrets.required` names from Doppler, writes a temporary secrets file, and passes it to native `wrangler deploy --secrets-file`. Auth declares `[]` and follows this same path with an empty JSON secrets file.

Doppler is the source for runtime secret values, including the build Worker's `CF_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`; Cloudflare receives copies on deployment. Platform additionally requires `CTX_APP_OAUTH_PROVISIONING_SECRET` in `platform/prod`, with the same value in `web/prod` for web's trusted provisioning endpoint. The bootstrap Doppler token and registry credential remain in the build environment and must not become runtime Worker bindings. In their default production Wrangler configurations, dispatcher declares only `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT`, and auth declares no required secrets. Doppler value changes take effect on the next deployment. Production migrations run separately from Worker deployment.

Use the release tool's help for its commands, options, and stopping points:

```sh
node --import tsx scripts/release.ts --help
node --import tsx scripts/release.ts audit
node --import tsx scripts/release.ts verify
```

The release ladder bumps package versions and the lockfile, commits with `gitc`, pushes main, waits for its `check.yml` run, and pushes a version tag. Pushing `vX.Y.Z` starts `release.yml`, which requires a successful check for that exact commit and verifies every package version against the tag before publishing. Its final rung watches the release run. Manual workflow dispatch remains available. Only packages without `private: true` publish; currently these are `@usecontextlayer/cli` and `@usecontextlayer/sdk`. GitHub receives `NPM_TOKEN` and `FONTAWESOME_PACKAGE_TOKEN` through Doppler sync. The former publishes packages; the latter installs the dashboard's private icons during CI. Releases do not deploy Twilio.

Public setup uses `npx @usecontextlayer/cli` consistently without a global installation: log in, initialize a project, and start its normal `pnpm dev` command. CLI help owns command syntax and prerequisites; the published CLI README owns the setup/publication sequence, and the generated project's README replaces the scaffold's standalone deployment instructions.

`packages/twilio/README.md` owns its service configuration and deployment details. Do not recreate the old product deployment images or services as part of routine setup.

## Faux worktrees and change summaries

A faux worktree is a sibling clone made by `setup-faux-worktree <existing_folder> <new_branch>` and removed by `close-faux-worktree`; it has its own `.git`, so Git worktree commands do not apply. Always ask before creating one for a spec. One worktree per spec is the usual shape described in [PRODUCT-DEVELOPMENT-v1.md](prompts/PRODUCT-DEVELOPMENT-v1.md).

`/describe-changes` narrates a range's actual behavior and files. `/close-faux-worktree` owns the landing sequence: current CI-equivalent gates plus all local integration tiers before merging. Account for every failure and skip; do not silently drop a landing gate.

## Skills

The third-party skills are owned by `npx skills` and `skills-lock.json`; never hand-edit installed skill content or the lock. `.agents/skills` is the store and `.claude/skills` is the view. The skill store is excluded from root Biome checks so installed content keeps its upstream formatting. Reconcile the view with `skills-sync`, without hand-maintaining symlinks. After a skills operation, format the changed lock/config files and verify formatting; include those formatting changes alongside the skill update when committing.

## Doppler

Local platform and deployed-service configuration live in the ContextLayer workplace. Authentication is directory-scoped and case-sensitive: run `doppler me` before use and stop if it reports another workplace or no scoped token. Do not borrow a token or log in ad hoc to bypass a missing directory scope.

Pass the project and config explicitly with `doppler run -p <project> -c <config> -- <cmd>`. Reads are fine; creating or changing projects, configs, or secrets is user-territory. Propose the exact change to the user.

Configs inherit values from their environment's root config and override only their local settings. Set shared values at the root rather than duplicating them in branch configs. A branch's secret listing includes inherited values, so presence does not establish that the value was set on that branch.

## Cloudflare and Fly.io

For Cloudflare operations, use `npx cf`; configuration stays in Wrangler's format. The Workers in `packages/platform`, `packages/build`, and `packages/dispatcher` use `pnpm exec wrangler` for build and deployment. The `cf` configuration cannot represent the build Worker’s Artifacts push-event triggers. Fly commands must target the `contextlayer` organization: pass `--org contextlayer` where supported, and verify with `fly orgs list` or the app's `fly status` before any mutation. Do not create an app as a side effect. Keep Fly deployments to one machine (`--ha=false` when creating machines); changes beyond a plain deploy require discussion with the user.

## Sentry

Sentry org `803-inc` owns the reporting projects; `sentry project list` is the live inventory. Use the retained Sentry skills for CLI operations, error triage, and instrumentation; they do not authorize changing the remote service.

When interpreting telemetry, sampling means counts are not traffic rates; span start order does not establish dependencies, and overlapping spans must not be summed as elapsed user wait. Attribute subprocess spans by working directory, not just command name. For streamed responses, HTTP 200 alone does not prove a successful render.

## Troubleshooting

The user permits pnpm to rebuild `node_modules` when installation requires it. In a non-interactive shell, use `CI=true` to accept that operation.

Run commands directly (`pnpm`, `npx`, `node`); do not prefix them with `mise exec`. Mise provides the installed tool versions through the shell environment. If a command reports a runtime or version error, stop and ask before changing the environment or invocation. Keep the enforced version floor.

Run a failing Turbo task alone to read its output. Shared-machine cleanup requires exact ownership: stop only your own PIDs and reclaim only your own databases. Report resources of uncertain ownership and ask before removing them.

### Dashboard user-menu verification

Follow [Platform development](#platform-development), then open the platform dashboard's account menu. Existing web device sessions should be listed; switching accounts should update the user and navigate to Personal, loading that user's app list. Add account opens web sign-in with the dashboard return URL. Sign out revokes the session through web and returns to sign-in. Restore the baseline user in the regular browser after verifying account switching.

The workspace switcher beside the user menu navigates between `/dashboard/personal/apps` and `/dashboard/org/<slug>/apps`. Open `/dashboard` to start in Personal. Verify the selected workspace name, navigate between workspaces, and refresh the organization URL. For local creation, use `ctx init my-app` for Personal and `ctx init --org <selected-slug> my-app` for organizations. Testing organization-owned creation locally requires a CLI login issued by the same local web server used by platform.

## Remote resources for integration tests

The [integration fixtures](#tests-and-local-postgres) select native Wrangler `env: "test"` with prebuilt platform and dispatcher bundles. Both use `contextlayer-test` for their remote bindings, separate from production's `contextlayer-prod`. Vitest owns isolated databases and harness lifetimes; Wrangler owns local Durable Objects and containers. Scenario app IDs name remote repositories and deployed Workers, and each run reclaims only those it creates.

For manual publication verification, load the build Worker's normal `dist` bundle in the native harness with `env: "test"`, alongside platform. Its `PUBLICATION` binding targets `contextlayer-platform-test`'s `Publication` entrypoint. The build test configuration has no Artifacts event subscription; invoke that service binding to exercise registration without the CI deployment pipeline. Its R2, Workflow and container bindings remain local to the harness.

Provision the reusable namespaces once in the configured Cloudflare account: pnpm exec wrangler dispatch-namespace create contextlayer-test and npx cf artifacts namespaces create --namespace contextlayer-test. cf resource operations accept CLOUDFLARE_ACCOUNT_ID for explicit account selection and use native Cloudflare authentication. Wrangler deployment places authored test Workers in that test dispatch namespace. Teardown uses npx cf workers-for-platforms dispatch-namespaces scripts delete <app-id> --dispatch-namespace contextlayer-test --force, then the native Artifacts binding deletes that run's repositories. The test namespace itself is retained. Install/run cf through npx.

## Polar sandbox webhook and access verification

Apply migration 005 with the normal platform database command before using billing state. For production, register a Polar endpoint for `customer.created` and `customer.state_changed`, API version `2026-10`, at platform's `/api/polar/webhooks`. Store its signing secret as `POLAR_WEBHOOK_SECRET` in Doppler `platform/prod`, alongside `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT=production`, `POLAR_FREE_PRODUCT_ID` and `POLAR_CLIPS_METER_ID` for the matching production catalog. Configure a recurring Free product with a fixed zero price, no metered price and the native non-rollover Clips credit benefit. Production also requires matching `CTX_APP_OAUTH_PROVISIONING_SECRET` values in `platform/prod` and `web/prod`, as described under [Releases and deployment](#releases-and-deployment).

Allow for asynchronous Polar delivery when verifying signup enrollment and credit fulfillment.

Polar locks pricing type at creation. Replacing a metered Free product requires creating a genuine Free product and attaching the native credit benefit. Archive the replaced catalog entry so new customers see the intended Free plan. Existing subscriptions retain their native prices and benefits; catalog replacement does not migrate them.

For local webhook delivery, follow [Platform development](#platform-development): the Polar CLI listener supplies the signing secret and forwards Sandbox events, and startup derives the Clips meter from the selected Free product. Keep Sandbox and production credentials and databases separate. Doppler mutations remain user-owned.

`billing.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), funded baseline Free customers and an existing paid recurring Sandbox product. It checks missing-state gating, personal/organization Free admission, Owner isolation, declaration access and non-Free admission without a live balance lookup. The non-Free case selects configuration and isolated SQL without starting a Worker. It creates a Sandbox customer, a single-use 100% forever discount and a native paid checkout/subscription; cleanup deletes its customer and discount while leaving the baseline on Free. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- billing.node.integration.test.ts
```

Polar Sandbox usage ingestion is authorized for all tests and their reruns. Exhaustion scenarios own their customers and preserve the baseline owners’ credits; immutable Sandbox events remain as provider history. Customer-credentials vault writes still require the user’s authorization for each write. For a manual portal check, use an isolated Free customer without payment details and verify the native portal can add a Sandbox payment method and upgrade; portal plan changes must be enabled.

`billing-free.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), including the saved CLI login and the running platform, database and Polar listener. It verifies signed Free enrollment for scenario-owned individual/team customers, derives the expected grant from the Free product's meter-credit benefit, exhausts that grant and checks runtime/Tools denial and declaration access. It creates Sandbox customers, writes scenario app rows in the development database and ingests immutable usage events; cleanup deletes those apps and customers, while provider history remains. It preserves the baseline customers and creates no separate Worker or database. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- billing-free.node.integration.test.ts`.

Before changing a catalog product, inspect existing subscriptions separately; catalog replacement does not migrate them. Sandbox tests do not configure production or deploy services.

## App usage verification

Dispatcher and platform require `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` through their package-local `env.ts`. Use the Sandbox configuration from [Platform development](#platform-development) for local verification. Deploy platform and dispatcher together. Production requires `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT=production` in Doppler `platform/prod`, plus platform's `CTX_APP_OAUTH_PROVISIONING_SECRET` matching `web/prod`. Both Workers use [Releases and deployment](#releases-and-deployment); dispatcher's default configuration declares only its Polar values. External configuration changes remain user-owned.

Shared unit tests exercise the public request/response classification contract for dynamic reads, mutation verbs, redirects and uncharged assets/declarations.

`usage.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), dispatcher build, funded baseline customers and an ACTIVE personal Gmail connection for the baseline user. Authorize that connection through `pnpm dev:ctx connections add gmail` and its human browser approval; the test discovers it through the normal API. The suite checks GET/POST dispatch, credential stripping, Gmail profile execution and per-app Owner billing, including personal-account use by an organization-owned app. It creates apps and local web OAuth registrations, pushes Slates to remote test Artifacts repositories, deploys authored Workers and assigns the discovered account. It performs read-only Gmail profile calls and records immutable Sandbox `loader_call` (one clip), `action_call` (three clips) and `tool_call` (one clip) usage for each app's Owner. The body deletes its deployed Workers and repositories before fixtures reclaim isolated SQL/files; local web registrations and provider event history remain. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- usage.node.integration.test.ts
```

## Chrome development

Remove the old SDK loader re-export when upgrading; re-export only Layout from `@usecontextlayer/sdk/react`. Verify unpublished changes with matching locally packed CLI and SDK packages and the generated app's own typecheck/build.

Existing apps must change `workers/local-tools/index.ts` to export only `Tools` from `@usecontextlayer/sdk/local` and remove imports of `viewerContext` and `connectionsContext`.

When installing unpublished CLI and SDK tarballs in a demo, installing the CLI as a direct file dependency does not force the SDK's transitive CLI dependency to use it. Add a native pnpm override in the demo's pnpm-workspace.yaml so both resolve to the local CLI tarball, then run pnpm install and restart the app's dev server. This belongs only in the temporary unpublished-package setup; published matching versions resolve normally.

```yaml
overrides:
  '@usecontextlayer/cli': 'file:/absolute/path/to/local-cli.tgz'
```

## Verifying the app-connection read

Verify local configuration from an app root using the built CLI. Change an app or agent Slate without pushing and confirm the next local listing reflects it. Local choices live only in .contextlayer/connections.json; production assignment listing is not involved. Folder construction creates ignored .contextlayer/folders/{slug} directories, and secret values come only from exact-name environment variables. Listing displays connection requirements and saved account IDs without printing secrets. packages/cli/__tests__/resources.test.ts exercises real current-folder filesystem construction, consumer selection with resolved inputs, binding preservation, declaration edits, folder creation, and isolation. Run through `pnpm exec turbo run test --filter=@usecontextlayer/cli...`.

For hosted connection configuration, sign in with `ctx login` and use an AppID/hostname CLI target. For an organization-owned requirement, authorize/list the account through the explicitly authorized organization account-management operations before assigning it.

For live account selection, use the intended CTX_PLATFORM_URL and the auth issuer/client matching the saved CLI login. Verify local execution through an authored route using the saved developer account, and hosted execution through the published declaration and assignment. Development runtime declaration/configuration edits require restarting pnpm dev.

## Iframe chrome verification

Authored-app chrome is disabled during local development. Verify it through a hosted app using pushed declarations and production assignments. The frame lives at `/dashboard/chrome/apps/:target` on platform's existing router. Sign in through web to verify native-session authentication. Native session cookies must remain Secure, HttpOnly, and SameSite=None; browser third-party-cookie policy still applies.

Run `pnpm exec turbo run tsc test build --filter=@usecontextlayer/platform... --filter=@usecontextlayer/sdk... --concurrency=4`. Web's viewer-session, platform-identity and trusted-origins integration suites need the sibling checkout's [test prerequisites](../web/DEVELOPING.md#tests), including shared Postgres and web's Doppler configuration; they do not need the connected services or saved CLI login. They check native cookie attributes, logout revocation, origin rejection and general API rejection of viewer credentials, writing only isolated test SQL. From `../web`, run `doppler run -p web -c dev_personal -- pnpm test:integration lib/__tests__/viewer-session.integration.test.ts lib/__tests__/platform-identity.integration.test.ts lib/__tests__/trusted-origins.integration.test.ts`; web's fixtures do not read Doppler themselves.

Browser verification must use HTTPS on different sites for app and frame, with third-party cookies permitted; localhost ports alone do not reproduce production cookie delivery. Sign in on web, then load the app with no extra sign-in interaction. Check the native profile, saved assignments, tray resize, authenticated reload, and logout revocation. Confirm the authored parent cannot read the frame DOM and receives only presentation messages. Check that the frame CSP permits intended app subdomains and blocks unrelated embedding. A same-origin dashboard form should succeed; a credentialed cross-site form submission should return 403 through Hono's CSRF middleware. Secure cookies remain required during development, so use a browser-supported secure localhost context or HTTPS rather than changing cookie attributes.
