# Developing

See [DOCS.md](DOCS.md) for document ownership and [Architecture](ARCHITECTURE.md#domain-model) for the domain vocabulary used below.

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

The `ctx login` / `ctx whoami` flow requires web's OAuth device extension and a public CLI client linked to the platform resource. The ordinary CLI defaults to the production issuer, client ID and platform URL; use the [connected development procedure](#platform-development) for local work. Only localhost/127.0.0.1 issuers permit HTTP in the CLI. Credentials are written to `auth.json` in the selected CLI config directory with owner-only permissions on creation. See `ctx --help` for `CTX_CONFIG_DIR` and its default. To keep concurrent logins, select a separate directory in each terminal before logging in; approve the device code using the intended web identity. For example, impersonate the intended user in web before approving a second account's CLI login. Interactive login remains a CLI command; connected tools pass the same directory setting through `@usecontextlayer/cli/auth`.

Build the local `ctx` executable, then invoke it from the repository root:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/cli
pnpm ctx --version
pnpm ctx init ../my-react-router-slate
```

Run the built CLI's `ctx login` to configure its credential helper for this OS user. Configuration points Git at the executable used for login; run login again if that installation moves. Git needs native `authtype` credential support. Login and init must target the same platform URL so Git's configured URL scope matches the remote.

Create test checkouts outside this repository. Create Cloudflare reuses an enclosing Git repository instead of initializing a nested one, so testing inside this repo prevents the generated checkout from having its own Git root and origin. The pnpm executable must also work from the generated checkout; a machine-wide mise default supplies it outside repo-local tool configuration, without `mise exec` or a CLI workaround.

`ctx init <directory>` uses the official Cloudflare React Router scaffold through `pnpm create cloudflare@latest`, accepting defaults, initializing Git, and disabling deployment. The generated checkout owns its `pnpm dev` and `pnpm build` commands. `CTX_PLATFORM_URL` is read in the CLI's `env.ts` and defaults to `https://platform.usecontextlayer.com`. Initialization does not push. Relative directories resolve from the calling directory. The version comes from `packages/cli/package.json`. Run `pnpm exec turbo run dev:watch --filter=@usecontextlayer/cli` to rebuild the CLI as its source changes.

## OAuth registration and migration

Follow the [resource and scope contract](ARCHITECTURE.md#oauth-resources-and-scopes). Keep the issuer, client registration and all consumers in the same environment; local initialization must use local web.

Use the checkout's `.env.json` record for selected local service addresses; do not add a global environment registry, hostname pool or platform-resource setting. Follow the [connected development procedure](#platform-development) for local setup.

For a new environment, register resources and the public CLI client through Better Auth's native operations, link the client to the platform resource, and allow the device-code and refresh-token grants with `platform:access` and `offline_access`. Let normal CLI device login and MCP authorization issue credentials.

For an existing environment, inspect native resource registrations, client scopes and client-resource links before proposing changes. Coordinate caller/verifier changes with registration updates, including resource `allowedScopes`, while preserving `offline_access`; source edits do not update registrations or saved grants. Remote configuration changes require the operator’s approval for each write. Re-run CLI login and MCP authorization afterward. Production slate OAuth provisioning requires the same `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `platform/prod` and `web/prod`; see [Releases and deployment](#releases-and-deployment).

## Platform viewer authentication

Runtime viewer authentication checks the copied session through web's /api/auth/get-session using the bearer plugin.

See [Viewer sign-in boundary](ARCHITECTURE.md#viewer-sign-in-boundary--principles) for the authentication flow being verified.

For native browser session development, follow [Platform development](#platform-development), then open the printed platform dashboard URL with the baseline web session.

To check the dashboard sign-in redirect with curl, send `Accept: text/html`; curl's default wildcard header receives 401. Use the platform URL printed by connected startup for local verification.

`auth.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), including running web/viewer services and the saved baseline CLI login. It checks viewer-cookie restrictions, native-form CSRF, JSON mutations through native sessions and CLI tokens, scoped resource inputs and public declarations through an isolated platform database and Worker; an Owner with no Polar customer deliberately stops authenticated execution at 402. It creates slates through the native-session API, provisions remote test Artifacts repositories and local web OAuth registrations, creates and revokes native web/viewer sessions, and writes isolated SQL rows. Fixture cleanup removes the repositories; local web OAuth registrations remain. It performs no vault writes or provider execution. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- auth.node.integration.test.ts`. This exercises the HTTP handoff and platform boundaries; the combined slate/chrome visitor experience requires slate push and deployment.

Browser form fixtures must send the same-origin Origin or Sec-Fetch-Site metadata that browsers supply. JSON fixtures must carry application/json.

`mcp.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), funded baseline personal and organization Free customers, and the dispatcher build. It checks MCP metadata, cookie rejection, slate-bound authorization, cross-slate/management rejection and native viewer access using local web consent and PKCE exchange. The authentication case creates a slate, its remote test Artifacts repository, and local web OAuth registrations/grants; fixture cleanup removes the repository and signs out the web session. Run only that case with `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- mcp.node.integration.test.ts --testNamePattern 'bind MCP'`.

The complete MCP file additionally needs the authored-build requirements from [Platform development](#platform-development). It builds an authored echo slate through the SDK, runs a native MCP client against the platform/dispatcher fixtures, and checks discovery, View delivery, successful tool execution and rejected arguments. It deploys a disposable Worker to `contextlayer-test`; the successful echo call schedules a Sandbox usage event through the normal usage reporter. The test body deletes its deployed Worker before fixture teardown, and the slate fixture deletes its Artifacts repository; local web OAuth registrations remain because no slate-deletion operation removes them. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- mcp.node.integration.test.ts`.

`slate-usage.node.integration.test.ts` selects service configuration and the saved baseline CLI identity from the connected fixtures. It calls the shared `recordSlateUsage` with the real Polar SDK and asserts Polar's native acknowledgment of one inserted event and zero duplicates. It writes one Sandbox usage event with a unique slate ID. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- slate-usage.node.integration.test.ts`.

## Slate ownership

Run `ctx login` before `ctx init`. See `ctx init --help` for organization selection.

Configure hosted personal inputs in the chrome; there is no separate join command. See [membership and resource ownership](ARCHITECTURE.md#slate-membership-and-unattended-execution) for the automatic provisioning rules.

## Local slate resources

Local CLI configuration uses only the current checkout's `public/slate.json` and `agents/{name}/slate.json`, ignored `.contextlayer/connections.json` assignments, exact-name secret environment variables, and native database configuration and committed migrations. Listing does not require Git metadata, a login, a running development server, or a platform request. The CLI adds `/.contextlayer/` to the slate's `.gitignore` while preserving existing content. Local SQLite-backed Durable Objects persist in `.contextlayer/databases`. Use the commands' `--help` for connecting and assigning accounts. For a live smoke check, call a read-only tool or query through an authored route and verify its observable response. React Router index actions require the native `?index` query parameter on direct POST requests, as framework Form submissions supply.

Run the generated checkout's `pnpm dev` command for local resources. Development-startup inputs require restarting pnpm dev after declaration/configuration changes.

[The SDK README](packages/sdk/README.md) documents the loader API and Gmail example. [Architecture](ARCHITECTURE.md#key-contract-slate-resource-requirements) owns the connection-slug contract and runtime boundaries. When verifying unpublished source, install locally packed CLI and SDK packages in the generated checkout.

## Resource Owner verification

The [auth integration suite](#platform-viewer-authentication) exercises personal-account authentication boundaries using connected baseline web, the saved CLI login and isolated platform SQL.

`connection-owner.node.integration.test.ts` needs only [shared Postgres](#tests-and-local-postgres). It writes isolated SQL and checks resource Owner selection, connection assignments and owner-only configuration without a vault token or connected services. It performs no provider execution or vault reads/writes. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- connection-owner.node.integration.test.ts
```

`slate-resources.node.integration.test.ts` needs the [connected test prerequisites](#platform-development) and an existing ACTIVE personal Gmail connected account for the baseline user. It lists that account through the normal API and CLI and assigns it through the slate chrome; it performs no connected-provider execution or vault write. It drives the slate-creation API, Git and CLI to check pushed declarations for the app and agents independently of local declarations and assignments, including rejection of caller-supplied Resources. It creates and deletes remote test Artifacts repositories, leaves slate OAuth registrations in local web, and writes isolated SQL assignments and temporary Git files. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- slate-resources.node.integration.test.ts`.

`agents.test.ts` verifies personal/organization Owner selection with a distinct acting user, without fake Artifacts, web, or Doppler. Run through `pnpm exec turbo run test --filter=@usecontextlayer/platform`. See [Deploying and inspecting an agent](#deploying-and-inspecting-an-agent) for the Git deployment integration.

Prompt-only hosted Pi jobs need no Docker container for agent execution. Scheduled-job verification uses Docker for the build Worker fixture that invokes provisioning. See [Authored agents](ARCHITECTURE.md#authored-agents) for runtime storage and resource ownership.

A live job proof needs deployed agent instructions and `agents/{name}/slate.json` declaring `ANTHROPIC_API_KEY`, a valid `public/slate.json` using the same schema, and the selected Owner's key in the configured development vault. Service-tool jobs also need connection requirements in their own declaration and existing Owner connected accounts assigned through the slate connection API. Private viewer-mode execution establishes membership once whole-slate setup is complete; connection and secret configuration can happen before membership. Database jobs need committed native SQL migrations and successful deployment or initial membership provisioning. Drive the built Worker through the native fixtures and hosted job endpoints. Native `harness.update(current => current)` reloads the Worker while retaining SQLite, after which job inspection and authored queries can verify persisted status, results and database rows. Reacquire native bindings with `worker.getEnv()` after reload for owned-resource cleanup. Record model output as observational evidence rather than asserting exact wording or tool ordering.

For hosted job verification, create through `POST /api/slates/{target}/agents/{name}/jobs` and retain both the returned catalog entry and native receipt; the response's `Location` identifies catalog detail. Check provenance and discovery through `GET /jobs` and `GET /jobs/{id}`, inspect execution through `/jobs/{id}/operation`, and await the final native result through `/jobs/{id}/result`. Schedule verification should provision the authored cron normally, inspect `/schedules` and `/schedules/{scheduleId}`, then discover its fired jobs with `/jobs?schedule=<authored-name>`. Native schedule `time` is in seconds; catalog timestamps are in milliseconds. Use a source-authorized native web or CLI identity for schedule inspection and lifecycle mutations. On an owned disposable job, `DELETE /jobs/{id}/operation` returns the native abort boolean while retaining catalog discovery; `DELETE /jobs/{id}` removes the job through its native lifecycle and returns HTTP 204.

## Slate database verification

`slate-databases.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), Docker, and normal platform and build bundles. It uses the shared native fixtures, including build’s `PROVISIONING` binding to platform and native viewer execution, to exercise first-use membership before and after deployment, owner/viewer database isolation, committed migration history, pending migrations and preserved rows. It queries scoped SQLite Durable Object instances through their native capability; its first-use SQL requires funded baseline organization billing state but no connected account or model key. Its source repositories, SQL database, temporary files, Durable Objects and harness belong to the run and are reclaimed together. Run:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/platform --filter=@usecontextlayer/build
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- slate-databases.node.integration.test.ts
```

`slate-first-use.node.integration.test.ts` verifies automatic personal provisioning and owner-only access. It needs the [connected setup](#platform-development), Docker, built platform/build bundles, funded baseline personal billing and Owner-vault names-read configuration. It uses a native web session and viewer handoff, without saved CLI login, a connected account, model key or vault writes. Its fixtures reclaim disposable test Artifacts source, isolated SQL, local runtime state and files; local web OAuth registrations remain. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- slate-first-use.node.integration.test.ts`.

`slate-assignment.node.integration.test.ts` verifies partial/final assignment and personal provisioning through chrome and the API. It needs the [connected setup](#platform-development), Docker, the platform bundle and an existing ACTIVE personal Gmail account for the baseline user. It uses a native web session, without a saved CLI login, provider execution or vault writes. Fixtures reclaim disposable test Artifacts source, isolated SQL, local runtime state and files; local web OAuth registrations remain. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- slate-assignment.node.integration.test.ts`.

## Platform development

Run the connected environment from this repository with Node and workspace dependencies installed as in [Setup](#setup), the sibling `../web` checkout installed and built, Docker running, and Wrangler authenticated for the remote `contextlayer-test` resources. Doppler must resolve to the ContextLayer workplace in both checkout directories: check `doppler me` in each before use, because web's configuration is read with `../web` as the working directory. The `@polar-sh/cli` install script, allowed by `pnpm-workspace.yaml`, must have unpacked its native `polar` binary during `pnpm install`.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Initialize and start local web, platform, viewer auth, dispatcher and Polar Sandbox forwarding. Keep it running while developing or running connected tests. |
| `pnpm dev:ctx <args>` | Run the built CLI with the selected local platform URL, web issuer, initialized public CLI client and checkout-local saved login. |
| `pnpm dev:env` | Print shell-safe connection settings for an arbitrary command in a subshell. |

Startup asks the OS for available ports of 3000 or higher for web, platform, viewer auth and dispatcher, then records their complete service URLs and initialized public CLI client ID in this checkout's ignored `.env.json` file after initialization completes. On later starts, it reuses the entire saved set only if all four ports meet that minimum and are free; if any is occupied, it assigns four new ports. Ctrl+C stops the stack and returns exit code 0. The file persists after shutdown. `dev:ctx`, `dev:env` and connected platform tests read it automatically, so another terminal needs no copied service-address exports. Separate checkouts have separate `.env.json` files. Local command composition selects `<checkout>/.contextlayer/cli` for saved CLI credentials; `dev:ctx`, `dev:env`, and connected suites use that same directory, independently of an inherited personal config directory. If the web port changes, run `pnpm dev:ctx login` again because the saved CLI credential belongs to the previous issuer.

Database URL and Polar overrides still need the same values in every terminal that uses them; another terminal does not inherit variables passed only to the startup process. `CTX_PLATFORM_DATABASE_URL` defaults to `postgresql://postgres:postgres@127.0.0.1:6489/contextlayer_platform`; web's `DATABASE_URL` defaults to `postgresql://postgres:postgres@127.0.0.1:5489/contextlayer_web`.

`pnpm dev` builds workspace dependencies through Turbo, reads Doppler `platform/dev` and `web/dev_personal`, starts both checkouts' Compose Postgres services without recreating running containers, creates the selected logical databases if absent, and runs each application's migrations. It starts native Next.js, React Router/Vite and Wrangler development for web, platform, viewer auth and dispatcher; the Workers select Cloudflare `test`. Concurrent stacks use the same sibling `../web` checkout, with a separate Next.js process and generated `.next/<web port>/dev` output for each stack. Once the services listen, it starts the Polar listener, invokes web's baseline initializer and prints the selected URLs. An owned service exiting stops startup, including during initialization. Credit grants arrive asynchronously. Repeated initialization reuses the baseline user, organization and public CLI client. The organization slug `local-development` and client name `ContextLayer Development CLI` are hardcoded constants.

Doppler `platform/dev` supplies provider credentials, including `COMPOSIO_API_KEY` and Sandbox Polar credentials. `readPolarEnv` reads `POLAR_FREE_PRODUCT_ID` from that config with the invoking environment overriding it; the same precedence applies to `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT`, which must be `sandbox`. The composition supplies the selected Polar token/environment to web, platform and dispatcher. It derives `CTX_AUTH_ISSUER` from the web URL, selects `CTX_PLATFORM_DATABASE_URL` from the parsed addresses, discovers `POLAR_CLIPS_METER_ID` through the Free product's meter-credit benefit, and obtains `POLAR_WEBHOOK_SECRET` from the Polar CLI. These values do not need to be stored in `platform/dev`; no tunnel or manual issuer configuration is needed.

Slate provisioning requires `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `web/dev`, inherited by `web/dev_personal`; connected setup passes that one value to local web and platform. A provisioning failure rolls back SQL but can leave the Artifacts repository. Do not maintain a second local secret copy in `platform/dev` or point local provisioning at production web.

Use your regular browser at the printed web URL, signed in as the baseline `CTX_DEV_USER_EMAIL` (`local-dev@usecontextlayer.com`); the email/password inputs live in Doppler `web/dev` and are inherited by `web/dev_personal`. Sign out of any other localhost account before opening a CLI device link. In another terminal, run `pnpm dev:ctx login` and approve its device request in that same browser, then run `pnpm dev:ctx whoami`. Keep that browser session for development and ordinary CLI approvals. Better Auth binds a device code to the first signed-in user who opens it; if another account claimed it, switch accounts and start a fresh login. Open the printed platform dashboard URL for browser development.

After initialization, `dev:ctx`, `dev:env`, and connected fixtures read the completed checkout record and use the same command-settings composer. Obtaining command settings requires no Doppler download, web database lookup, or client-discovery subprocess; `dev:ctx` then runs the requested CLI command. Ordinary `pnpm ctx` retains its normal environment and production defaults. `dev:env` exports the four service URLs, `CTX_PLATFORM_DATABASE_URL`, `DATABASE_URL`, `CTX_AUTH_ISSUER`, `CTX_AUTH_CLIENT_ID` and `CTX_CONFIG_DIR`. It does not export access tokens, baseline credentials, Polar overrides or the applications' Doppler secret sets.

`dev:env` writes shell assignments to stdout and leaves command banners and diagnostics on stderr. Use its output directly with `eval`, without `--silent`, in a subshell so the parent shell stays unchanged:

```sh
(eval "$(pnpm dev:env)" && python my-script.py)
```

Connected platform integration suites select their prerequisites through the shared fixtures. Native web/viewer cases need the running services; cases using `identity`, `organization` or CLI commands also need the saved baseline CLI login for this issuer/client. Each suite's section states its additional requirements. Build platform and CLI for suites using those surfaces; MCP and usage also need the dispatcher build:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/platform --filter=@usecontextlayer/cli --filter=@usecontextlayer/dispatcher
```

Shared fixtures acquire Doppler-backed service prerequisites only when selected; command settings come from the checkout record. Invoke test commands directly without a `doppler run` wrapper. Authored-slate test builds must run Vite with `NODE_ENV=production` in the build subprocess. Fixtures select the native web session and sign it out, read the saved CLI identity and baseline organization membership, and share service configuration. Tests select an isolated platform database, platform Worker, dispatcher Worker, build Worker and temporary directory as needed; the CLI environment targets the selected platform Worker. The Free-enrollment suite selects the running development database and platform instead. See [Tests and local Postgres](#tests-and-local-postgres) for fixture selection and cleanup, and each suite's section for external writes.

Slates created by `ctx init` start on `main`. Initialization requires the saved login and Git author identity before scaffolding or slate creation. Missing or rejected login receives the shared `ctx login` guidance; Git's own error output supplies missing-identity configuration instructions.

Wrangler’s native `secrets.required` list imports process configuration into Worker bindings; do not maintain a `.dev.vars` copy. `CTX_SLATES_DOMAIN` defaults to `contextlayer.xyz`. The default `ARTIFACTS` and `SLATES` bindings select `contextlayer-prod`; connected startup and integration harnesses select native `test` bindings using remote `contextlayer-test` repositories and user Workers.

The platform package's `dev:watch` uses Cloudflare Vite with the source entrypoint, while its `dev` uses Wrangler with the compiled bundle and source Wrangler configuration. Both select `test` and run in workerd, defaulting to port 3010. Vite preview uses the bindings selected at build time; changing `CLOUDFLARE_ENV` only at preview startup does not select another namespace. There is no Node production server or `CTX_PLATFORM_PORT` setting.

Apply `008_polar_customer_state_refreshed_at` before starting platform against an existing database in each environment. It replaces `event_timestamp` with non-null, database-stamped `refreshed_at`, including for existing rows. Production migrations run separately from Worker deployment. Connected startup migrates without regenerating source. To migrate and regenerate Kanel types against the same selected platform database, use the initialized command environment:

```sh
(eval "$(pnpm dev:env)" && pnpm exec turbo run db.latest --filter=@usecontextlayer/platform)
```

The migration command reads `CTX_PLATFORM_DATABASE_URL` and passes that URL to Kanel as its child-process `DATABASE_URL`. A bare `doppler run -p platform -c dev -- …` selects Doppler's database URL, which need not match connected startup's parsed default or override.

The local server prints its root URL; open `/dashboard/personal/slates` for the dashboard. Changing Vite's base to `/dashboard/` would put its modules inside the dashboard authentication/routing gate.

Run `pnpm dev:ctx init <directory>` against the connected local environment. Commit the generated checkout’s changes, then push with `git push origin HEAD:main`. The slate appears at `/dashboard/personal/slates` immediately after initialization. `/api/openapi.json` describes creation, listing, hostname resolution, and visibility updates.

`platform.node.integration.test.ts` needs the connected test prerequisites above. It exercises personal/organization slate creation, absence of creator auto-membership, visibility, listing, dashboard rendering, agent deployment and Git push/clone/pull through the API and built CLI. It creates and deletes remote test Artifacts repositories and leaves slate OAuth registrations in local web; its SQL, files and Git configuration are isolated and reclaimed by the fixtures. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- platform.node.integration.test.ts
```

`ownership.node.integration.test.ts` needs only [shared Postgres](#tests-and-local-postgres), without the connected services or CLI login. It checks that each slate has exactly one personal or organization Owner and writes only disposable SQL rows. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- ownership.node.integration.test.ts`.

## Shared secret management verification

Use the [connected test prerequisites](#platform-development) for Owner-owned secret management. The built CLI's `secrets --help`, `secrets set --help`, and `secrets drop --help` own input and Owner-selection syntax. Doppler `platform/dev` supplies `CTX_OWNER_CREDENTIALS_DOPPLER_PROJECT=customer-credentials-local`, `CTX_OWNER_CREDENTIALS_DOPPLER_CONFIG=prod`, and a read/write service token scoped to that vault as `CTX_OWNER_CREDENTIALS_DOPPLER_TOKEN`. Production `platform/prod` supplies the corresponding settings for `customer-credentials/prod`. Platform declares these runtime secrets; dispatcher does not. Provisioning or changing Doppler tokens/config/secrets remains user-owned. Viewer-secret presence reads, value loading and mutations require these settings; owner-only configuration does not read vault names. Unrelated platform routes remain usable without them.

The non-writing cases in `secrets.node.integration.test.ts` need the [connected test prerequisites](#platform-development) and Composio configuration, but no vault token. They exercise anonymous/other-Owner denial, OpenAPI discovery, stdin guidance, organization selection and real personal/organization connected account listing through the API and CLI. They make no vault writes and connect no Composio accounts or create OAuth authorization links. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- secrets.node.integration.test.ts --testNamePattern non-writing
```

The live Doppler case additionally needs the vault's config-scoped token and user authorization for each write, naming the exact Owner/key and vault destination before execution. It checks stdin preservation, replacement, Owner isolation, deletion and the absence of values/credentials in output, using a generated `CTX_SECRET_E2E_` name for the baseline user and organization. It creates a personal secret through CLI stdin, creates an organization secret with the same name through CLI stdin, replaces the personal value through PUT, replaces the organization value through CLI stdin, then drops the personal secret through CLI and the organization secret through DELETE. These writes target the configured vault, normally `customer-credentials-local/prod`; provider reads check the raw values without printing them. A failed run can leave test secrets present; inspect and agree cleanup before any further write. After authorization covers each write, run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- secrets.node.integration.test.ts
```

`slate-secret-setup.node.integration.test.ts` needs the connected setup, Docker, the platform bundle and Owner-vault configuration. It uses a native web session and disposable pushed declarations/migrations, without a saved CLI login, connected account or model execution. Its `non-writing` case reads vault names and performs no vault mutations. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- slate-secret-setup.node.integration.test.ts --testNamePattern non-writing`. The `live Doppler` case requires separate approval for exactly four mutations in the configured development vault, normally `customer-credentials-local/prod`, under the baseline user's personal Owner: create `CTX_SLATE_SETUP_E2E_20261015_PRIMARY` through the slate API, create `CTX_SLATE_SETUP_E2E_20261015_SECONDARY` through the chrome action, then delete each through the Owner API. Name the exact Owner, keys and vault before obtaining approval; running the non-writing case is not authorization for these writes. The case refuses to overwrite existing keys, compares raw values without printing them and attempts both cleanup deletes on exit. A failed run can leave keys present; inspect and agree any further cleanup before writing again. Fixtures reclaim source, SQL, local runtime state and files; local web OAuth registrations remain. After approval covers all four mutations, select only this case with `--testNamePattern 'live Doppler'`.

Do not automate Clack's terminal renderer or add pseudo-terminal plumbing to this suite.

## Deploying and inspecting an agent

Add `agents/<name>/instructions.md` to a checkout and push through its normal `/git/<slate-id>` remote. See [Authored agents](ARCHITECTURE.md#authored-agents) for inspection, authorization, and revision semantics.

Declare schedules as `agents/<name>/schedules/<prompt>.md` with YAML frontmatter such as `cron: "0 7 * * 1-5"` and the user prompt in the Markdown body. Cron is canonical five-field UTC.

`platform.node.integration.test.ts` needs the [connected test prerequisites](#platform-development). It checks deployed instructions and their commit before and after a Git push, alongside source-access authorization. It writes and deletes its remote test Artifacts repositories, leaves slate OAuth registrations in local web, and reclaims its isolated database and temporary Git files. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- platform.node.integration.test.ts
```

`agent-jobs.node.integration.test.ts` verifies prompt-only Pi API execution through the normal built platform Worker, native web session and real Anthropic model. It needs the connected environment above and a usable `ANTHROPIC_API_KEY` under the baseline user's personal Owner in the configured development vault. It needs no saved CLI login, connected provider account or Docker container for agent execution. The test creates and deletes a disposable test Artifacts repository, pushes an authored agent through native Git, submits two fresh jobs, checks native receipts/results and catalog listing, and rejects conversation continuation input. Its fixtures reclaim isolated SQL, local Worker state and temporary files. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- agent-jobs.node.integration.test.ts
```

The prompt-only case in `agent-schedules.node.integration.test.ts` provisions one authored UTC cron through the native `PROVISIONING` binding, waits for its real SDK alarm, then verifies the fresh Pi job through the public list/detail API. It needs the connected environment, normal platform/build/CLI bundles, Docker for the build Worker fixture, and the same usable personal Owner model key as API execution. Its disposable slate declares no connected accounts or databases. Run only this case with:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/platform... --filter=@usecontextlayer/build...
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- agent-schedules.node.integration.test.ts --testNamePattern 'authored cron starts a fresh Pi job visible through the API'
```

The broader member/Gmail/database case in `agent-schedules.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), Docker, normal platform/build/CLI bundles, an ACTIVE personal Gmail connected account for the baseline user, and `ANTHROPIC_API_KEY` for the selected user and organization in the development vault. Connect accounts and configure keys before running; vault writes still need the user’s per-write authorization. The suite deploys agent declarations, schedules and checked-in SQL migrations, exercises final connection assignments establishing membership before and after deployment, and observes real native cron firings and API jobs. Gmail calls are read-only; jobs insert scenario proof rows through `database_query`. It reloads the native Worker and reads persisted job results and database rows. Fixture and scenario cleanup reclaim only the run’s source repositories and local resources. Run:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/platform --filter=@usecontextlayer/build --filter=@usecontextlayer/cli
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- agent-schedules.node.integration.test.ts
```

## Running an agent locally

Build the CLI with `pnpm exec turbo run build tsc --filter=@usecontextlayer/cli`. From a checkout containing `agents/<name>/instructions.md`, use `ctx agent --help` for local-run commands. When verifying unpublished source from another directory, invoke the checkout's built `packages/cli/dist/cli.mjs` with Node using its absolute path. Claude Agent SDK uses native Claude authentication, so an existing Claude login or SDK-supported model credential must be available. The command starts and stops the slate's local development server automatically and uses its persisted `.contextlayer/databases` state. If the app declares connections, the command also needs the matching saved CLI login; declarations with only databases need no ContextLayer login.

See [Authored agents](ARCHITECTURE.md#authored-agents) for local instruction composition and settings isolation. Verify instruction behavior with a real local task and record model output as observational evidence.

## Build Worker

Build and typecheck `packages/build` from the repository root with `pnpm exec turbo run build tsc --filter=@usecontextlayer/build`. Building the configured Sandbox image requires Docker. Deployment of the build Worker itself uses the shared repository-root workflow described under [Releases and deployment](#releases-and-deployment).

The `contextlayer-build-backups` R2 bucket stores Cloudflare CI build snapshots. Manage bucket-scoped Object Read & Write credentials as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the authored-slate Workers deployment API token as `CF_TOKEN`, centrally in Doppler `platform/prod`. Declare those three runtime secrets in the build Worker's native `secrets.required`; the shared deployment workflow supplies them through Wrangler without a `.dev.vars` copy. Platform must export the named `Provisioning` entrypoint before deploying the build Worker that calls it, and its production Artifacts namespace, dispatch namespace, and R2 bucket must exist before slate deployment runs.

Push a checkout created by `ctx init` through the running platform’s Git endpoint. In the Cloudflare dashboard, open Workflows → `contextlayer-build` and inspect the new instance’s `build` step. Its command output and status show whether the pushed commit built; a successful result includes the Cloudflare CI build snapshot. Cloudflare account access is required to inspect these runs. Inspect both the `build` and `deploy` steps to confirm deployment. To update a scheduled agent, keep public/slate.json and every agents/<name>/slate.json valid, commit its schedules/<prompt>.md with canonical five-field UTC cron frontmatter and a Markdown user prompt, and push normally.

## Dispatch Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/dispatcher`. Deploy through the shared repository-root workflow described under [Releases and deployment](#releases-and-deployment). The `contextlayer-prod` WfP namespace must exist before deployment. Platform must export the named `Execution` entrypoint before deploying dispatcher with its `EXECUTION` service binding; local tests bind to `contextlayer-platform-test`.

Configure proxied wildcard DNS for `*.contextlayer.xyz`, where hosted slates serve. Wrangler attaches that route to `contextlayer-dispatcher`; platform serves separately at `https://platform.usecontextlayer.com`, the dispatcher’s `CTX_PLATFORM_URL`. Slate routing uses the deployed platform and its database; no local server or tunnel is required.

## Viewer auth Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/auth --filter=@usecontextlayer/dispatcher`. Auth uses Wrangler on `auth.contextlayer.xyz/*`, more specific than dispatcher's wildcard, and follows the same shared repository-root deployment workflow as the other Workers. Web must expose `/viewer/sign-in` and enable Better Auth's one-time-token and bearer plugins before deploying these Workers.

Auth's `CTX_AUTH_ISSUER` defaults to `https://www.usecontextlayer.com/api/auth`; dispatcher uses `CTX_VIEWER_AUTH_URL`, defaulting to `https://auth.contextlayer.xyz`, and auth uses `CTX_SLATES_DOMAIN`, defaulting to `contextlayer.xyz`. Web's `CTX_VIEWER_AUTH_URL` fixes the allowed callback destination. Verify that logging out on web makes the next private slate request require sign-in and public slates remain anonymously viewable.

## Tests and local Postgres

`pnpm test` runs the unit tier. `AGENTS.md` and `vitest.shared.ts` define the Node/browser runtimes and node/browser/Claude integration tiers. CI runs unit tests; integration tests are opt-in. Node unit suites run in cli, sdk, shared, dev-env, platform and mcp-microsoft-planner-premium; Node integration suites run in dev-env (Postgres) and platform (Cloudflare Artifacts, Polar sandbox and Postgres). Dispatcher behavior runs through platform’s native usage and MCP integrations.

Platform integration tests provision isolated databases on the server selected by `CTX_PLATFORM_DATABASE_URL`, defaulting to Compose Postgres on `127.0.0.1:6489`; see [Platform development](#platform-development) for address selection. Web's persistent development database on port 5489 is separate from the isolated platform SQL. Connected suites use the running web service and can create sessions, OAuth registrations and grants there; each suite’s verification section records its writes and cleanup. If the shared Compose server is not running, start it once:

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

Worker fixtures use Wrangler's native `createTestHarness()` with `env: "test"` and `prebuiltWorkerDir` pointing to platform's normal `build/server` bundle or dispatcher/build `dist` output. The provisioning fixture places platform and build in the same native harness so build’s `PROVISIONING` binding reaches the named platform entrypoint. Follow [Platform development](#platform-development) for builds and prerequisites. Fixtures supply native `secrets`, call `listen()` and register `close()` with `onCleanup`; Wrangler owns ports, readiness and runtime resources. Prompt-only Pi jobs do not require a Linux container; suites that start build or execution containers still require Docker. Use `getLogs()` for captured Worker logs. Platform's integration config retains a five-minute hook timeout and a normal 90-second test timeout; scenarios can declare a longer test timeout.

Register scenario cleanup with `await using` and `AsyncDisposableStack` inside the body, so Artifacts repositories and deployed Workers are deleted while the Worker fixture is alive: Vitest tears down test-scoped fixtures before `onTestFinished`. Reclaim repositories through the same configured `ARTIFACTS` binding used for creation, obtained with `worker.getEnv()`. Fixture-owned resources can use dependent `onCleanup` lifetimes, as the MCP slate fixture does. Keep the operation under test in the body.

## Releases and deployment

The production platform URL is `https://platform.usecontextlayer.com`. Production database configuration belongs in Doppler `platform/prod`; Neon's `platform` project owns the production database. Configure native Cloudflare Workers Builds for platform, dispatcher, auth, build, and mcp-microsoft-planner-premium against `main` in `usecontextlayer/contextlayer`, with repository root `/`. Every Worker uses the same root script, with only its package argument changing:

```sh
bash scripts/cloudflare.sh build <package>
bash scripts/cloudflare.sh deploy <package>
```

Use `platform`, `dispatcher`, `auth`, `build`, or `mcp-microsoft-planner-premium` as `<package>`. Workers Builds reads the repository-root `.node-version`; remove any separate `NODE_VERSION` build override. Set `PNPM_VERSION=11.22.0`, `SKIP_DEPENDENCY_INSTALL=true`, and `WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST=1` in each Workers Builds configuration. Registry authentication must be available before installation. Wrangler's native CI setting lets Docker image build steps use the runner's host network; Turbo's build task passes that exact variable through its strict environment filter.

Supply a config-scoped read-only service token for Doppler `platform/prod` as the Cloudflare build secret `DOPPLER_TOKEN`. Use the credential returned when creating the token; subsequent token listing/get calls return metadata without its value. The shared build phase installs the official Doppler CLI, obtains `FONTAWESOME_PACKAGE_TOKEN` through `scripts/ci.npmrc`, installs workspace dependencies, and runs the selected package's existing Turbo build. The deploy phase reads the effective Wrangler configuration, including Vite's generated configuration, obtains only its native `secrets.required` names from Doppler, writes a temporary secrets file, and passes it to native `wrangler deploy --secrets-file`. Auth declares `[]` and follows this same path with an empty JSON secrets file.

Doppler is the source for runtime secret values, including the build Worker's `CF_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`; Cloudflare receives copies on deployment. Platform additionally requires `CTX_APP_OAUTH_PROVISIONING_SECRET` in `platform/prod`, with the same value in `web/prod` for web's trusted provisioning endpoint. The bootstrap Doppler token and registry credential remain in the build environment and must not become runtime Worker bindings. In their default production Wrangler configurations, dispatcher declares only `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT`, and auth declares no required secrets. Doppler value changes take effect on the next deployment. Production migrations run separately from Worker deployment.

Use the release tool's help for its commands, options, and stopping points:

```sh
node --import tsx scripts/release.ts --help
node --import tsx scripts/release.ts audit
node --import tsx scripts/release.ts verify
```

The release ladder bumps package versions and the lockfile, commits with `gitc`, pushes main, waits for its `check.yml` run, and pushes a version tag. Pushing `vX.Y.Z` starts `release.yml`, which requires a successful check for that exact commit and verifies every package version against the tag before publishing. Its final rung watches the release run. Manual workflow dispatch remains available. Only packages without `private: true` publish; currently these are `@usecontextlayer/cli` and `@usecontextlayer/sdk`. GitHub receives `NPM_TOKEN` and `FONTAWESOME_PACKAGE_TOKEN` through Doppler sync. The former publishes packages; the latter installs the dashboard's private icons during CI. Releases do not deploy Twilio.

Public setup uses `npx @usecontextlayer/cli` consistently without a global installation: log in, initialize a checkout, and start its normal `pnpm dev` command. For public CLI onboarding and deployment, follow the [CLI README](packages/cli/README.md) and the generated checkout’s README. CLI help owns command syntax and prerequisites.

The [Twilio README](packages/twilio/README.md) owns its service configuration and deployment details.

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

Follow [Platform development](#platform-development), then open the platform dashboard's account menu. Existing web device sessions should be listed; switching accounts should update the user and navigate to Personal, loading that user's slate list. Add account opens web sign-in with the dashboard return URL. Sign out revokes the session through web and returns to sign-in. Restore the baseline user in the regular browser after verifying account switching.

The Owner switcher beside the user menu navigates between `/dashboard/personal/slates` and `/dashboard/org/<slug>/slates`. Open `/dashboard` to start in Personal. Verify the selected Owner name, navigate between Owners, and refresh the organization URL. For local creation, use `ctx init my-slate` for Personal and `ctx init --org <selected-slug> my-slate` for organizations. Testing organization-owned creation locally requires a CLI login issued by the same local web server used by platform.

## Remote resources for integration tests

The [integration fixtures](#tests-and-local-postgres) select native Wrangler `env: "test"` with prebuilt platform and dispatcher bundles. Both use `contextlayer-test` for their remote bindings, separate from production's `contextlayer-prod`. Vitest owns isolated databases and harness lifetimes; Wrangler owns local Durable Objects and containers. Scenario slate IDs name remote repositories and deployed Workers, and each run reclaims only those it creates.

For manual provisioning verification, load the build Worker's normal `dist` bundle in the native harness with `env: "test"`, alongside platform. Its `PROVISIONING` binding targets `contextlayer-platform-test`'s `Provisioning` entrypoint. The build test configuration has no Artifacts event subscription; invoke that service binding to exercise provisioning without the CI deployment pipeline. Its R2, Workflow and container bindings remain local to the harness.

Provision the reusable namespaces once in the configured Cloudflare account: pnpm exec wrangler dispatch-namespace create contextlayer-test and npx cf artifacts namespaces create --namespace contextlayer-test. cf resource operations accept CLOUDFLARE_ACCOUNT_ID for explicit account selection and use native Cloudflare authentication. Wrangler deployment places authored test Workers in that test dispatch namespace. Teardown uses npx cf workers-for-platforms dispatch-namespaces scripts delete <slate-id> --dispatch-namespace contextlayer-test --force, then the native Artifacts binding deletes that run's repositories. The test namespace itself is retained. Install/run cf through npx.

## Polar sandbox webhook and access verification

Run the platform database migrations before verifying billing state. For production, register a Polar endpoint for `customer.created` and `customer.state_changed`, API version `2026-10`, at platform's `/api/polar/webhooks`. Store its signing secret as `POLAR_WEBHOOK_SECRET` in Doppler `platform/prod`, alongside `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT=production`, `POLAR_FREE_PRODUCT_ID` and `POLAR_CLIPS_METER_ID` for the matching production catalog. Configure a recurring Free product with a fixed zero price, no metered price and the native non-rollover Clips credit benefit. Production also requires matching `CTX_APP_OAUTH_PROVISIONING_SECRET` values in `platform/prod` and `web/prod`, as described under [Releases and deployment](#releases-and-deployment).

Allow for asynchronous Polar delivery when verifying signup enrollment and credit fulfillment.

Polar locks pricing type at creation. Replacing a metered Free product requires creating a genuine Free product and attaching the native credit benefit. Archive the replaced catalog entry so new customers see the intended Free plan. Existing subscriptions retain their native prices and benefits; catalog replacement does not migrate them.

For local webhook delivery, follow [Platform development](#platform-development): the Polar CLI listener supplies the signing secret and forwards Sandbox events, and startup derives the Clips meter from the selected Free product. Keep Sandbox and production credentials and databases separate. Doppler mutations remain user-owned.

`billing.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), funded baseline Free customers and an existing paid recurring Sandbox product. It checks missing-customer refusal, recovery of missing state, personal/organization Free admission, Owner isolation, declaration access, and saved-state admission for Free and non-Free subscriptions. A scenario-owned Free customer is exhausted in Polar while its fresh saved balance still admits; aging `refreshed_at` in the isolated database makes the next check refresh and refuse. The Free balance and non-Free cases select configuration and isolated SQL without starting a Worker. The suite creates Sandbox customers, a single-use 100% forever discount and a native paid checkout/subscription; cleanup deletes its customers and discount while leaving the baseline on Free. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- billing.node.integration.test.ts
```

Polar Sandbox usage ingestion is authorized for all tests and their reruns. Exhaustion scenarios own their customers and preserve the baseline Owners’ credits; immutable Sandbox events remain as provider history. Owner vault writes still require the user’s authorization for each write. For a manual portal check, use an isolated Free customer without payment details and verify the native portal can add a Sandbox payment method and upgrade; portal plan changes must be enabled.

`billing-free.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), including the saved CLI login and the running platform, database and Polar listener. It verifies signed Free enrollment for scenario-owned individual/team customers, derives the expected grant from the Free product's meter-credit benefit, exhausts that grant, ages its scenario-owned saved state and checks runtime/Tools denial after refresh and declaration access. It creates Sandbox customers, writes scenario slate rows in the development database and ingests immutable usage events; cleanup deletes those slates and customers, while provider history remains. It preserves the baseline customers and creates no separate Worker or database. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- billing-free.node.integration.test.ts`.

Before changing a catalog product, inspect existing subscriptions separately; catalog replacement does not migrate them. Sandbox tests do not configure production or deploy services.

## Slate usage verification

Dispatcher and platform require `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` through their package-local `env.ts`. Use the Sandbox configuration from [Platform development](#platform-development) for local verification and follow the [dispatcher deployment prerequisites](#dispatch-worker). Production requires `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT=production` in Doppler `platform/prod`, plus platform's `CTX_APP_OAUTH_PROVISIONING_SECRET` matching `web/prod`. Both Workers use [Releases and deployment](#releases-and-deployment); dispatcher's default configuration declares only its Polar values. External configuration changes remain user-owned.

Shared unit tests exercise the public request/response classification contract for dynamic reads, mutation verbs, redirects and uncharged assets/declarations.

`execution.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), platform and CLI builds, funded baseline personal and organization customers, and an ACTIVE personal Gmail connected account for the baseline user. Connect that account through `pnpm dev:ctx connections add gmail` and its human browser approval; the suite discovers it through the normal API. Its native harness runs platform and a small caller Worker that invokes the actual Tools and Databases capabilities through platform's named `Execution` binding. It checks missing-plan refusal for tools and SQL, the billing message, undeclared-resource refusal, missing-setup 409 `connection-required` payloads before membership, and successful viewer-mode execution with automatic first-use membership after assignment. It creates slates through the API, pushes declarations and committed SQL migrations to remote test Artifacts repositories, assigns the discovered account, and verifies persisted viewer/owner SQL results. It performs read-only Gmail profile calls and checks exact `tool_call` Sandbox usage billed to each slate's personal or organization Owner. It does not build or deploy an authored slate. The body deletes its repositories before fixtures reclaim isolated SQL/files and native SQLite state; local web OAuth registrations and immutable Sandbox event history remain. Run `pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- execution.node.integration.test.ts`.

`usage.node.integration.test.ts` needs the [connected test prerequisites](#platform-development), dispatcher build and funded baseline personal and organization customers. It runs the actual local dispatcher against a simple echo Worker deployed to `contextlayer-test`, checking GET/POST dispatch, request-body preservation, credential stripping and exact slate-Owner usage. It creates slates and local web OAuth registrations and deploys disposable Workers directly with native Wrangler; it needs no source push, SDK build or connected account. It records exactly one Sandbox `loader_call` (one clip) and one `action_call` (three clips) event for each slate's Owner. The body deletes its deployed Workers and repositories before fixtures reclaim isolated SQL/files; local web registrations and immutable provider event history remain. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- usage.node.integration.test.ts
```

## Slate chrome development

See [Slate chrome](ARCHITECTURE.md#slate-chrome) for its boundary and the [SDK README](packages/sdk/README.md) for `Layout` integration. Verify unpublished changes with matching locally packed CLI and SDK packages and the generated checkout’s own typecheck/build.

Use the current `workers/local-resources` files from the CLI template when updating a development checkout. Follow [Local slate resources](#local-slate-resources) to reset its local database state. Verify that the deployment build excludes the auxiliary Worker and local credentials.

When installing unpublished CLI and SDK tarballs in a demo, installing the CLI as a direct file dependency does not force the SDK's transitive CLI dependency to use it. Add a native pnpm override in the demo checkout's `pnpm-workspace.yaml` so both resolve to the local CLI tarball, then run pnpm install and restart the slate's dev server. This belongs only in the temporary unpublished-package setup; published matching versions resolve normally.

```yaml
overrides:
  '@usecontextlayer/cli': 'file:/absolute/path/to/local-cli.tgz'
```

## Verifying the slate-connection read

Verify local configuration from a checkout root using the built CLI. Change an app or agent declaration without pushing and confirm the next listing reflects it. Local assignments live only in `.contextlayer/connections.json`; secret values come only from exact-name environment variables. Follow [Authored database development](#authored-database-development) for migration authoring and application. Listing displays connection requirements and saved connected account IDs without printing secrets. `packages/cli/__tests__/resources.test.ts` exercises checkout-based configuration, consumer selection, assignment preservation, declaration edits, migration artifacts and isolation. Run through `pnpm exec turbo run test --filter=@usecontextlayer/cli...`.

For hosted connection configuration, sign in with `ctx login` and use a SlateID/hostname CLI target. For an organization-owned requirement, connect the account and list connected accounts through the explicitly authorized organization connected account management operations before assigning it.

For live connection assignment, use the intended CTX_PLATFORM_URL and the auth issuer/client matching the saved CLI login. Verify local execution through an authored route using the saved developer connected account, and hosted execution through the deployed declaration and assignment. Development runtime declaration/configuration edits require restarting pnpm dev.

## Slate chrome verification

The [slate chrome](ARCHITECTURE.md#slate-chrome) is disabled during local development. Verify it through a hosted slate using pushed declarations and hosted assignments. Its iframe URL is `/dashboard/chrome/slates/:target` on platform. Sign in through web to verify native-session authentication. Native session cookies must remain Secure, HttpOnly, and SameSite=None; browser third-party-cookie policy still applies.

Run `pnpm exec turbo run tsc test build --filter=@usecontextlayer/platform... --filter=@usecontextlayer/sdk... --concurrency=4`. Web's viewer-session, platform-identity and trusted-origins integration suites need the sibling checkout's [test prerequisites](../web/DEVELOPING.md#tests), including shared Postgres and web's Doppler configuration; they do not need the connected services or saved CLI login. They check native cookie attributes, logout revocation, origin rejection and general API rejection of viewer credentials, writing only isolated test SQL. From `../web`, run `doppler run -p web -c dev_personal -- pnpm test:integration lib/__tests__/viewer-session.integration.test.ts lib/__tests__/platform-identity.integration.test.ts lib/__tests__/trusted-origins.integration.test.ts`; web's fixtures do not read Doppler themselves.

Browser verification must use HTTPS on different sites for the slate and the chrome iframe, with third-party cookies permitted; localhost ports alone do not reproduce hosted cookie delivery. Sign in on web, then load the slate with no extra sign-in interaction. Check the native profile, saved assignments, tray resize, authenticated reload, and logout revocation. Confirm the authored parent cannot read the chrome iframe DOM and receives only presentation messages. Check that the chrome iframe CSP permits intended slate subdomains and blocks unrelated embedding. A same-origin dashboard form should succeed; a credentialed cross-site form submission should return 403 through Hono's CSRF middleware. Secure cookies remain required during development, so use a browser-supported secure localhost context or HTTPS rather than changing cookie attributes.

## Authored database development

`ctx init` installs native Drizzle ORM/Kit and supplies the SQL-first `db:migration` script, template instructions and `databases/updates` example. Keep each database’s configuration, query schema and native migration output under `databases/<slug>`. Declare its slug/mode in the app or agent declaration. Run `pnpm db:migration --config databases/<slug>/drizzle.config.ts --name <change>`, write the blank SQL explicitly, and update `schema.ts` for query types. Commit SQL and the native `meta/_journal.json` together. Never run schema-diff generation or `drizzle-kit push`. Multiple statements use the native `--> statement-breakpoint` separator.

Use the [SDK database example](packages/sdk/README.md#a-loader-that-queries-cached-data) from loaders and actions to verify the migrated schema through an authored route.

Restart local development to apply edited migration files. Push committed migrations through the normal slate deployment workflow for existing members; provisioning applies the latest committed history for new members when they join. See [Database provisioning and resource ownership](ARCHITECTURE.md#slate-forking-membership-and-resource-ownership) for provisioning and execution invariants.
