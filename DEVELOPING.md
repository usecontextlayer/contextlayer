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

## Connected development

Run the connected environment from this checkout with Node and workspace dependencies installed as in [Setup](#setup), the sibling `../web` checkout installed and built, Docker running, and Wrangler authenticated for the remote `contextlayer-test` resources. Doppler must resolve to the ContextLayer workplace in both checkout directories: check `doppler me` in each before use, because web's configuration is read with `../web` as the working directory. The `@polar-sh/cli` install script, allowed by `pnpm-workspace.yaml`, must have unpacked its native `polar` binary during `pnpm install`.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Initialize and start local web, platform, viewer auth, dispatcher and Polar Sandbox forwarding. Keep it running while developing or running connected tests. |
| `pnpm dev:ctx <args>` | Run the built CLI with the selected local platform URL, web issuer, initialized public CLI client and checkout-local saved login, in the directory pnpm was invoked from. |
| `pnpm dev:env` | Print shell-safe connection settings for an arbitrary command in a subshell. |

Startup asks the OS for available ports of 3000 or higher for web, platform, viewer auth and dispatcher, then records their complete service URLs, the initialized public CLI client ID and the selected platform database URL in this checkout's ignored `.env.json` file after initialization completes. On later starts, it reuses the entire saved set of ports only if all four meet that minimum and are free; if any is occupied, it assigns four new ports. Ctrl+C stops the stack and returns exit code 0. The file persists after shutdown. `dev:ctx`, `dev:env` and connected platform tests read it automatically, so another terminal needs no copied service-address exports. Separate checkouts have separate `.env.json` files. Local command composition selects `<checkout>/.contextlayer/cli` for saved CLI credentials; `dev:ctx`, `dev:env`, and connected suites use that same directory, independently of an inherited personal config directory. If the web port changes, run `pnpm dev:ctx login` again because the saved CLI credential belongs to the previous issuer.

Each checkout gets its own platform database, named `<checkout folder>_platform`, on the server that `CTX_PLATFORM_DATABASE_URL` names: the main checkout uses `contextlayer_platform` and a faux worktree uses its folder name. Startup creates it if absent and records its URL in `.env.json`, so `dev:ctx`, `dev:env` and the connected fixtures read it from there. Web database URL and Polar overrides still need the same values in every terminal that uses them; another terminal does not inherit variables passed only to the startup process. Web's `DATABASE_URL` defaults to `postgresql://postgres:postgres@127.0.0.1:5489/contextlayer_web` and is shared by every checkout, because the web checkout is.

`pnpm dev` builds workspace dependencies through Turbo, reads Doppler `platform/dev` and `web/dev_personal`, starts both checkouts' Compose Postgres services without recreating running containers, creates the selected logical databases if absent, and runs each application's migrations. It starts native Next.js, React Router/Vite and Wrangler development for web, platform, viewer auth and dispatcher; the Workers select Cloudflare `test`. Concurrent stacks use the same sibling `../web` checkout, with a separate Next.js process and generated `.next/<web port>/dev` output for each stack. Once the services listen, it starts the Polar listener, invokes web's baseline initializer and prints the selected URLs. An owned service exiting stops startup, including during initialization. Credit grants arrive asynchronously. Repeated initialization reuses the baseline user, organization and public CLI client. The organization slug `local-development` and client name `ContextLayer Development CLI` are hardcoded constants.

Doppler `platform/dev` supplies provider credentials, including `COMPOSIO_API_KEY` and Sandbox Polar credentials. `readPolarEnv` reads `POLAR_FREE_PRODUCT_ID` from that config with the invoking environment overriding it; the same precedence applies to `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT`, which must be `sandbox`. The composition supplies the selected Polar token/environment to web, platform and dispatcher. It derives `CTX_AUTH_ISSUER` from the web URL, selects `CTX_PLATFORM_DATABASE_URL` from the parsed addresses, discovers `POLAR_CLIPS_METER_ID` through the Free product's meter-credit benefit, and obtains `POLAR_WEBHOOK_SECRET` from the Polar CLI. These values do not need to be stored in `platform/dev`; no tunnel or manual issuer configuration is needed.

Slate provisioning requires `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `web/dev`, inherited by `web/dev_personal`; connected setup passes that one value to local web and platform. A provisioning failure rolls back SQL but can leave the Artifacts repository. Do not maintain a second local secret copy in `platform/dev` or point local provisioning at production web.

Use your regular browser at the printed web URL, signed in as the baseline `CTX_DEV_USER_EMAIL` (`local-dev@usecontextlayer.com`); the email/password inputs live in Doppler `web/dev` and are inherited by `web/dev_personal`. Sign out of any other localhost account before opening a CLI device link. In another terminal, run `pnpm dev:ctx login` and approve its device request in that same browser, then run `pnpm dev:ctx whoami`. Keep that browser session for development and ordinary CLI approvals. Better Auth binds a device code to the first signed-in user who opens it; if another account claimed it, switch accounts and start a fresh login. For a second identity against the same stack, run the built CLI inside a `dev:env` subshell with `CTX_CONFIG_DIR` pointing at another directory, impersonate the intended user in web, and approve that device code there; one login lives in each directory. Open the printed platform dashboard URL for browser development.

After initialization, `dev:ctx`, `dev:env`, and connected fixtures read the completed checkout record and use the same command-settings composer. Obtaining command settings requires no Doppler download, web database lookup, or client-discovery subprocess. `dev:ctx` then runs the requested CLI command in the directory pnpm was invoked from, so `pnpm -C <checkout> dev:ctx …` acts on the current directory from anywhere. `dev:env` exports the four service URLs, `CTX_PLATFORM_DATABASE_URL`, `DATABASE_URL`, `CTX_AUTH_ISSUER`, `CTX_AUTH_CLIENT_ID` and `CTX_CONFIG_DIR`. It does not export access tokens, baseline credentials, Polar overrides or the applications' Doppler secret sets.

`dev:env` writes shell assignments to stdout and leaves command banners and diagnostics on stderr. Use its output directly with `eval`, without `--silent`, in a subshell so the parent shell stays unchanged:

```sh
(ctx_env=$(pnpm dev:env) && eval "$ctx_env" && python my-script.py)
```

Wrangler’s native `secrets.required` list imports process configuration into Worker bindings; do not maintain a `.dev.vars` copy. `CTX_SLATES_DOMAIN` defaults to `contextlayer.xyz`. The default `ARTIFACTS` and `SLATES` bindings select `contextlayer-prod`; connected startup and integration harnesses select native `test` bindings using remote `contextlayer-test` repositories and user Workers.

The platform package's `dev:watch` uses Cloudflare Vite with the source entrypoint, while its `dev` uses Wrangler with the compiled bundle and source Wrangler configuration. Both select `test` and run in workerd, defaulting to port 3010. Vite preview uses the bindings selected at build time; changing `CLOUDFLARE_ENV` only at preview startup does not select another namespace. There is no Node production server or `CTX_PLATFORM_PORT` setting.

Apply `008_polar_customer_state_refreshed_at` before starting platform against an existing database in each environment. It replaces `event_timestamp` with non-null, database-stamped `refreshed_at`, including for existing rows. Production migrations run separately from Worker deployment. Connected startup migrates without regenerating source. To migrate and regenerate Kanel types against the same selected platform database, use the initialized command environment:

```sh
(ctx_env=$(pnpm dev:env) && eval "$ctx_env" && pnpm exec turbo run db.latest --filter=@usecontextlayer/platform)
```

The migration command reads `CTX_PLATFORM_DATABASE_URL` and passes that URL to Kanel as its child-process `DATABASE_URL`. A bare `doppler run -p platform -c dev -- …` selects Doppler's database URL, which need not match the one startup recorded.

The local server prints its root URL; open `/dashboard/personal/slates` for the dashboard. Changing Vite's base to `/dashboard/` would put its modules inside the dashboard authentication/routing gate.

## Developing with a local slate

A slate created against the connected stack is the vehicle for developing most of the system: web as the issuer and baseline user, platform for slate creation, the dashboard, connections, assignment and tool execution, the SDK installed in the slate, and the CLI for init, login and the Vite plugin that serves local resources. The ordinary development loop runs the slate's own dev server against this stack.

With `pnpm dev` running, build the CLI, log in through the stack, and create the slate outside this repository:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/cli
pnpm dev:ctx login
pnpm dev:ctx init ../my-slate
```

`dev:ctx` runs the built CLI with the stack's issuer, client, platform URL and checkout-local login, so the slate is registered in the local platform and appears at `/dashboard/personal/slates` immediately. Approve the device code in the browser session signed in as the baseline user, as described under [Connected development](#connected-development). See `ctx init --help` for organization selection. Run `pnpm exec turbo run dev:watch --filter=@usecontextlayer/cli` to rebuild the CLI and starter as their source changes. Initialize a fresh slate to verify starter edits; rebuilding does not update an existing slate's files.

Create slates outside this repository so they have an independent Git root and package-manager workspace. The pnpm executable must also work from the generated checkout; a machine-wide mise default supplies it outside repo-local tool configuration, without `mise exec` or a CLI workaround.

Before starting the slate to verify unpublished CLI or SDK changes, follow [Verifying unpublished CLI and SDK in a slate checkout](#verifying-unpublished-cli-and-sdk-in-a-slate-checkout) to install matching local packages.

Commands that act on the slate checkout, such as a local connection assignment or a local agent run, read the current directory. Run them from inside the checkout through this checkout's `dev:ctx`, which keeps the directory pnpm was invoked from:

```sh
cd ../my-slate
pnpm -C <path-to-this-checkout> dev:ctx connections local assign <slug> <connection_id>
```

From inside the slate checkout, start its own dev server inside a `dev:env` subshell so its Vite startup finds the stack's issuer, client and login:

```sh
(ctx_env=$(pnpm -C /path/to/contextlayer-checkout dev:env) && eval "$ctx_env" && pnpm dev)
```

For Git source verification, push from inside the slate checkout with the connected environment so Git's credential helper uses the local issuer, client and saved login. Commit any edits you want to include before pushing. This stores source in `contextlayer-test`; it does not trigger a Cloudflare build or deployment:

```sh
(ctx_env=$(pnpm -C /path/to/contextlayer-checkout dev:env) && eval "$ctx_env" && git push origin HEAD:main)
```

`/api/openapi.json` describes creation, listing, hostname resolution, and visibility updates.

The `ctx login` / `ctx whoami` flow requires web's OAuth device extension and a public CLI client linked to the platform resource; connected startup initializes that client. Only localhost/127.0.0.1 issuers permit HTTP in the CLI. Credentials are written to `auth.json` in the selected CLI config directory with owner-only permissions on creation. `ctx --help` prints the issuer, client, platform URL and config directory in use, and `ctx whoami` prints the identity those settings verify. `dev:ctx` keeps one login per checkout in `.contextlayer/cli`. Approve its device code as the intended web identity; for example, impersonate that user in web before approving. Interactive login remains a CLI command; connected tools pass the same directory setting through `@usecontextlayer/cli/auth`.

`ctx login` also configures Git's credential helper for this OS user, pointing Git at the executable used for login; run login again if that installation moves. Git needs native `authtype` credential support. Login and init must target the same platform URL so Git's configured URL scope matches the remote.

Configure hosted personal inputs in the chrome; there is no separate join command. See [membership and resource ownership](ARCHITECTURE.md#slate-membership-and-unattended-execution) for the automatic provisioning rules.

## Faux worktrees and change summaries

A faux worktree is a sibling clone made by `setup-faux-worktree <existing_folder> <new_branch>` and removed by `close-faux-worktree`; it has its own `.git`, so Git worktree commands do not apply. Always ask before creating one for a spec. One worktree per spec is the usual shape described in [PRODUCT-DEVELOPMENT-v1.md](prompts/PRODUCT-DEVELOPMENT-v1.md).

Run the connected stack from the worktree as from any checkout. It selects its own ports, writes its own `.env.json`, and gets its own platform database named after the worktree folder, while sharing the sibling `../web` checkout and web's database with every other stack. Nothing drops that database when the worktree closes.

`/describe-changes` narrates a range's actual behavior and files. `/close-faux-worktree` owns the landing sequence: current CI-equivalent gates plus all local integration tiers before merging. Account for every failure and skip; do not silently drop a landing gate.

## Verifying unpublished CLI and SDK in a slate checkout

`dev:ctx` runs this workspace's CLI, but the slate's Vite integration loads its installed SDK and CLI packages. `dev:env` supplies connection settings; it does not select package source. To verify unpublished CLI or SDK changes, build and pack both packages from the repository root, then install the resulting tarballs in the slate:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/cli --filter=@usecontextlayer/sdk
(cd packages/cli && pnpm pack)
(cd packages/sdk && pnpm pack)
cd ../my-slate
pnpm add /absolute/path/to/usecontextlayer-cli-<version>.tgz /absolute/path/to/usecontextlayer-sdk-<version>.tgz
```

Installing the CLI as a direct file dependency does not make the SDK's transitive CLI dependency use it; the SDK's Vite integration then loads the published CLI instead of your build. Add a native pnpm override in the slate's `pnpm-workspace.yaml` so both resolve to the local CLI tarball, run `pnpm install`, and restart the slate's dev server:

```yaml
overrides:
  '@usecontextlayer/cli': 'file:/absolute/path/to/usecontextlayer-cli-<version>.tgz'
```

This belongs only in the temporary unpublished-package setup; published matching versions resolve normally. Start the slate's dev server inside a `dev:env` subshell and run CLI commands against the checkout through `pnpm -C <path-to-this-checkout> dev:ctx …`, as under [Developing with a local slate](#developing-with-a-local-slate). Use the generated checkout's own typecheck and build as part of the verification.

## Local slate resources

Local CLI configuration uses only the current checkout's `public/slate.json` and `agents/{name}/slate.json`, ignored `.contextlayer/connections.json` assignments, exact-name secret environment variables, and native database configuration and committed migrations. Listing does not require Git metadata, a login, a running development server, or a platform request. Local SQLite-backed Durable Objects persist in `.contextlayer/databases`. Use the commands' `--help` for connecting and assigning accounts. For a live smoke check, call a read-only tool or query through an authored route and verify its observable response. React Router index actions require the native `?index` query parameter on direct POST requests, as framework Form submissions supply.

Run the generated checkout's `pnpm dev` command for local resources. Development-startup inputs require restarting pnpm dev after declaration/configuration changes.

[The SDK README](packages/sdk/README.md) documents the loader API and Gmail example. [Architecture](ARCHITECTURE.md#key-contract-slate-resource-requirements) owns the connection-slug contract and runtime boundaries. To verify unpublished source, follow [Verifying unpublished CLI and SDK in a slate checkout](#verifying-unpublished-cli-and-sdk-in-a-slate-checkout).

## Running an agent locally

Build the CLI with `pnpm exec turbo run build tsc --filter=@usecontextlayer/cli`. From a slate checkout containing `agents/<name>/instructions.md`, run `pnpm -C <path-to-this-checkout> dev:ctx agent --help` for local-run commands. Claude Agent SDK uses native Claude authentication, so an existing Claude login or SDK-supported model credential must be available. The command starts and stops the slate's local development server automatically and uses its persisted `.contextlayer/databases` state. If the app declares connections, the command also needs the matching saved CLI login; declarations with only databases need no ContextLayer login.

See [Authored agents](ARCHITECTURE.md#authored-agents) for local instruction composition and settings isolation. Verify instruction behavior with a real local task and record model output as observational evidence.

## Authored database development

Follow the [SDK database guide](packages/sdk/README.md#a-loader-that-queries-cached-data) to declare databases, author their migrations and query them through a loader or action.

Restart local development to apply edited migration files. Push committed migrations through the normal slate deployment workflow for existing members; provisioning applies the latest committed history for new members when they join. See [Database provisioning and resource ownership](ARCHITECTURE.md#slate-forking-membership-and-resource-ownership) for provisioning and execution invariants.

## Deploying and inspecting an agent

Add `agents/<name>/instructions.md` to a checkout and push through its normal `/git/<slate-id>` remote. See [Authored agents](ARCHITECTURE.md#authored-agents) for inspection, authorization, and revision semantics.

Declare schedules as `agents/<name>/schedules/<prompt>.md` with YAML frontmatter such as `cron: "0 7 * * 1-5"` and the user prompt in the Markdown body. Cron is canonical five-field UTC.

See platform guidance for [hosted model configuration](packages/platform/AGENTS.md#hosted-model-configuration) and [hosted-agent integration suites](packages/platform/AGENTS.md#hosted-agent-integration-suites).

## Slate chrome development

See [Slate chrome](ARCHITECTURE.md#slate-chrome) for its boundary and the [SDK README](packages/sdk/README.md) for `Layout` integration. Verify unpublished changes as under [Verifying unpublished CLI and SDK in a slate checkout](#verifying-unpublished-cli-and-sdk-in-a-slate-checkout), and the chrome itself through a hosted slate as under [slate chrome verification](packages/platform/AGENTS.md#slate-chrome-verification).

Use the current `workers/local-resources` files from the CLI template when updating a development checkout. Follow [Local slate resources](#local-slate-resources) to reset its local database state. Verify that the deployment build excludes the auxiliary Worker and local credentials.

## Verifying the slate-connection read

Verify local configuration from a checkout root using the built CLI. Change an app or agent declaration without pushing and confirm the next listing reflects it. Local assignments live only in `.contextlayer/connections.json`; secret values come only from exact-name environment variables. Follow [Authored database development](#authored-database-development) for migration authoring and application. Listing displays connection requirements and saved connected account IDs without printing secrets. `packages/cli/__tests__/resources.test.ts` exercises checkout-based configuration, consumer selection, assignment preservation, declaration edits, migration artifacts and isolation. Run through `pnpm exec turbo run test --filter=@usecontextlayer/cli...`.

For hosted connection configuration, sign in with `ctx login` and use a SlateID/hostname CLI target. For an organization-owned requirement, connect the account and list connected accounts through the explicitly authorized organization connected account management operations before assigning it.

For live connection assignment, use the intended CTX_PLATFORM_URL and the auth issuer/client matching the saved CLI login. Verify local execution through an authored route using the saved developer connected account, and hosted execution through the deployed declaration and assignment. Development runtime declaration/configuration edits require restarting pnpm dev.

## Tests and local Postgres

`pnpm test` runs the unit tier. `AGENTS.md` and `vitest.shared.ts` define the Node/browser runtimes and node/browser/Claude integration tiers. CI runs unit tests; integration tests are opt-in. Node unit suites run in cli, sdk, shared, dev-env, dispatcher, platform and mcp-microsoft-planner-premium; Node integration suites run in dev-env (Postgres) and platform (Cloudflare Artifacts, Polar sandbox and Postgres). Dispatcher browser-policy unit tests exercise the production Hono middleware; dispatch behavior runs through platform’s native usage and MCP integrations.

Platform integration tests provision isolated databases on the server selected by `CTX_PLATFORM_DATABASE_URL`, defaulting to Compose Postgres on `127.0.0.1:6489`; see [Connected development](#connected-development) for address selection. Web's persistent development database on port 5489 is separate from the isolated platform SQL. Connected suites use the running web service and can create sessions, OAuth registrations and grants there; each suite’s paragraph records its writes and cleanup. If the shared Compose server is not running, start it once:

```sh
docker compose up -d postgres
```

`packages/dev-env/__tests__/ephemeral.node.integration.test.ts` needs only that Postgres server. It checks database provisioning, caller-supplied migrations, failure cleanup and concurrent isolation. It creates and drops uniquely named databases on the selected server and makes no cloud/provider writes. Run:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/dev-env -- ephemeral.node.integration.test.ts
```

Do not stop, restart or reset the shared Postgres instance. Reclaim only databases your session created; report suspected leftovers and ask before cleaning up another session's resources. An interrupted test can leave databases behind, so a prefix alone never proves a database is safe to delete.

The root commands `test:integration:node`, `test:integration:browser`, and `test:integration:claude` select individual tiers. `test:integration` requests all three.

Platform's integration suites, their prerequisites, their external writes and their run commands are documented in [platform integration suites](packages/platform/AGENTS.md#platform-integration-suites); fixture ownership and resource lifetimes in [platform integration fixtures](packages/platform/AGENTS.md#platform-integration-fixtures).

## OAuth registration and migration

Follow the [resource and scope contract](ARCHITECTURE.md#oauth-resources-and-scopes). Keep the issuer, client registration and all consumers in the same environment; local initialization must use local web.

Use the checkout's `.env.json` record for selected local service addresses; do not add a global environment registry, hostname pool or platform-resource setting. Follow [Connected development](#connected-development) for local setup.

For a new environment, register resources and the public CLI client through Better Auth's native operations, link the client to the platform resource, and allow the device-code and refresh-token grants with `platform:access` and `offline_access`. Let normal CLI device login and MCP authorization issue credentials.

For an existing environment, inspect native resource registrations, client scopes and client-resource links before proposing changes. Coordinate caller/verifier changes with registration updates, including resource `allowedScopes`, while preserving `offline_access`; source edits do not update registrations or saved grants. Remote configuration changes require the operator’s approval for each write. Re-run CLI login and MCP authorization afterward. Production slate OAuth provisioning requires the same `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `platform/prod` and `web/prod`; see [Releases and deployment](#releases-and-deployment).

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

## Build Worker

Build and typecheck `packages/build` from the repository root with `pnpm exec turbo run build tsc --filter=@usecontextlayer/build`. Building the configured Sandbox image requires Docker. Deployment of the build Worker itself uses the shared repository-root workflow described under [Releases and deployment](#releases-and-deployment).

Verify provisioning through the existing [test service-binding setup](packages/platform/AGENTS.md#remote-resources-for-integration-tests).

The `contextlayer-build-backups` R2 bucket stores Cloudflare CI build snapshots. Manage bucket-scoped Object Read & Write credentials as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the authored-slate Workers deployment API token as `CF_TOKEN`, centrally in Doppler `platform/prod`. Declare those three runtime secrets in the build Worker's native `secrets.required`; the shared deployment workflow supplies them through Wrangler without a `.dev.vars` copy. Platform must export the named `Provisioning` entrypoint before deploying the build Worker that calls it, and its production Artifacts namespace, dispatch namespace, and R2 bucket must exist before slate deployment runs.

For production slate deployments, push a checkout created against the production platform through that platform’s Git endpoint. Pushes to its `contextlayer-prod` Artifacts namespace trigger the deployed build workflow. In the Cloudflare dashboard, open Workflows → `contextlayer-build` and inspect the new instance’s `build` step. Its command output and status show whether the pushed commit built; a successful result includes the Cloudflare CI build snapshot. Cloudflare account access is required to inspect these runs. Inspect both the `build` and `deploy` steps to confirm deployment. To update a scheduled agent, keep public/slate.json and every agents/<name>/slate.json valid, commit its schedules/<prompt>.md with canonical five-field UTC cron frontmatter and a Markdown user prompt, and push normally.

## Dispatch Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/dispatcher`. Deploy through the shared repository-root workflow described under [Releases and deployment](#releases-and-deployment). The `contextlayer-prod` WfP namespace must exist before deployment. Platform must export the named `Execution` entrypoint before deploying dispatcher with its `EXECUTION` service binding; local tests bind to `contextlayer-platform-test`.

Configure proxied wildcard DNS for `*.contextlayer.xyz`, where hosted slates serve. Wrangler attaches that route to `contextlayer-dispatcher`; platform serves separately at `https://platform.usecontextlayer.com`, the dispatcher’s `CTX_PLATFORM_URL`. Slate routing uses the deployed platform and its database; no local server or tunnel is required.

## Viewer auth Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/auth --filter=@usecontextlayer/dispatcher`. Auth uses Wrangler on `auth.contextlayer.xyz/*`, more specific than dispatcher's wildcard, and follows the same shared repository-root deployment workflow as the other Workers. Web must expose `/viewer/sign-in` and enable Better Auth's one-time-token and bearer plugins before deploying these Workers.

Auth's `CTX_AUTH_ISSUER` defaults to `https://www.usecontextlayer.com/api/auth`; dispatcher uses `CTX_VIEWER_AUTH_URL`, defaulting to `https://auth.contextlayer.xyz`, and auth uses `CTX_SLATES_DOMAIN`, defaulting to `contextlayer.xyz`. Web's `CTX_VIEWER_AUTH_URL` fixes the allowed callback destination. Verify that logging out on web makes the next private slate request require sign-in and public slates remain anonymously viewable.

## Polar configuration

Run the platform database migrations before verifying billing state. For production, register a Polar endpoint for `customer.created` and `customer.state_changed`, API version `2026-10`, at platform's `/api/polar/webhooks`. Store its signing secret as `POLAR_WEBHOOK_SECRET` in Doppler `platform/prod`, alongside `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT=production`, `POLAR_FREE_PRODUCT_ID` and `POLAR_CLIPS_METER_ID` for the matching production catalog. Configure a recurring Free product with a fixed zero price, no metered price and the native non-rollover Clips credit benefit. Production also requires matching `CTX_APP_OAUTH_PROVISIONING_SECRET` values in `platform/prod` and `web/prod`, as described under [Releases and deployment](#releases-and-deployment).

Dispatcher and platform require `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` through their package-local `env.ts`. Use the Sandbox configuration from [Connected development](#connected-development) for local verification and follow the [dispatcher deployment prerequisites](#dispatch-worker). Both Workers use [Releases and deployment](#releases-and-deployment); dispatcher's default configuration declares only its Polar values. External configuration changes remain user-owned. Shared unit tests exercise the public request/response classification contract for dynamic reads, mutation verbs, redirects and uncharged assets/declarations.

Allow for asynchronous Polar delivery when verifying signup enrollment and credit fulfillment.

Polar locks pricing type at creation. Replacing a metered Free product requires creating a genuine Free product and attaching the native credit benefit. Archive the replaced catalog entry so new customers see the intended Free plan. Existing subscriptions retain their native prices and benefits; catalog replacement does not migrate them. Before changing a catalog product, inspect existing subscriptions separately. Sandbox tests do not configure production or deploy services.

For local webhook delivery, follow [Connected development](#connected-development): the Polar CLI listener supplies the signing secret and forwards Sandbox events, and startup derives the Clips meter from the selected Free product. Keep Sandbox and production credentials and databases separate. Doppler mutations remain user-owned. The billing and usage suites are under [platform integration suites](packages/platform/AGENTS.md#platform-integration-suites).

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
