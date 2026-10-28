# Developing

This guide owns setup and repo-wide operating workflows. Use the [domain model](ARCHITECTURE.md#domain-model) for vocabulary, [AGENTS.md](AGENTS.md) for construction and permission rules, and [TESTING.md](TESTING.md) for test execution and verification. [Documentation guidance](AGENTS.md#documentation) defines document ownership; package-specific instructions live in each package's AGENTS.md.

## Setup

The dashboard uses the private Font Awesome npm kit described in [`.font-awesome.md`](.font-awesome.md). The repository maps its npm scopes in `.npmrc`; configure the Font Awesome package token in your user npm configuration before installing dependencies. Never commit that token.

Run from the repository root:

```sh
mise trust
mise install
pnpm install --frozen-lockfile
```

Mise supplies the repository's pinned Node and pnpm versions; Corepack stays unused. `.node-version` owns the Node version across local development and CI, and the pnpm versions in `mise.toml` and `package.json` must agree. Install dependencies explicitly before running tasks: the workspace enforces the Node version floor and disables automatic dependency repair during task execution.

## Workspace commands

```sh
pnpm run check
pnpm run format.verify
pnpm run tsc
pnpm run build
```

`check` runs workspace-reference and Tailwind checks, fixes formatting, and typechecks. **It edits files.** Use `format.verify` to check formatting without editing. [TESTING.md](TESTING.md#running-tests) owns test commands.

For package-scoped work, use Turbo selectors:

```sh
pnpm exec turbo run build tsc --filter=@usecontextlayer/shared...
pnpm exec turbo run dev:watch --filter=@usecontextlayer/db-infra...
```

A server's `dev` starts it; `dev:watch` adds watching. A library's `dev:watch` rebuilds its output. Packages define only the forms they use, and Turbo owns dependency builds through `^build`.

## DevEnv

**Run development through the DevEnv. The built CLI's defaults select production and the user's personal saved login.** The runners below select this checkout's local services and login instead; follow the root [production boundary](AGENTS.md#production-is-never-a-development-target).

### Prerequisites and configuration

Complete [Setup](#setup), install and build the sibling `../web` checkout, start Docker, and authenticate Wrangler for the remote `contextlayer-test` resources. Local Worker execution still needs Cloudflare access; [test-resource setup](TESTING.md#cloudflare-test-resources) owns provisioning those shared resources. Installation must complete the Polar CLI's allowed install script so its native binary is available.

Check `doppler me` in both checkout directories: both must resolve to the ContextLayer workplace, because web's configuration is read from `../web`. Follow [Doppler](#doppler) for scope and mutation rules. Startup reads `platform/dev` and `web/dev_personal`.

Doppler `platform/dev` supplies provider credentials, including `COMPOSIO_API_KEY`, and the complete runtime Polar Sandbox configuration: `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT=sandbox`, `POLAR_FREE_PRODUCT_ID`, `POLAR_CLIPS_METER_ID`, and `POLAR_WEBHOOK_SECRET`. The shared seed publishes generated IDs and the CLI forwarding secret; startup only validates and consumes them. The invoking environment overrides Doppler for these five runtime values. Keep Sandbox credentials and databases separate from production.

Slate provisioning requires `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `web/dev`, inherited by `web/dev_personal`. DevEnv supplies that one value to local web and platform. Do not maintain a second local copy in `platform/dev` or point local provisioning at production web.

### Seed shared development state

Run `pnpm dev:seed` from this checkout after installing and building dependencies. It applies migrations and the web-owned SQL template to the database selected by `DATABASE_URL`, independently of running DevEnv services, then ensures the shared Polar Sandbox baseline. It mutates that web database, Polar Sandbox and Doppler `platform/dev`. Docker, sibling web dependencies and runtime configuration remain prerequisites. Supply an organization token and `POLAR_ENVIRONMENT=sandbox` in `platform/dev`; the token needs read/write access to meters, benefits, products, customers, subscriptions and organizations. The seed selects its Polar account from canonical Doppler configuration so published IDs and credentials belong to the same account; shell Polar overrides apply only to runtime.

[The checked-in fixture](packages/dev-env/seed.json) owns the fixed development login, identity and OAuth registration values, and catalog definitions. The SQL template prepares the baseline user, organization, owner membership, public CLI client and platform-resource link in each selected web database. Every such database has matching baseline identities and can change independently. The seed ensures matching personal and team Polar customers, one active private zero-price Unlimited subscription for each, the Clips meter and public Free/Pro/Ultra catalog, and portal plan changes. It publishes account-specific Polar runtime settings to `platform/dev`. The fixed public client ID and development credentials are imported directly from the fixture; Doppler does not supply them.

Run one Polar seed at a time. An unchanged rerun preserves persistent IDs and subscriptions, skips unchanged configuration writes, and completes missing relationships or interrupted publication. To adopt existing unmarked public products, supply their matching IDs in `platform/dev`: `POLAR_FREE_PRODUCT_ID`, `POLAR_PRO_PRODUCT_ID` and `POLAR_ULTRA_PRODUCT_ID`. `POLAR_CLIPS_METER_ID` identifies an existing meter. An existing unmarked private Unlimited product can be adopted with `POLAR_DEVENV_UNLIMITED_PRODUCT_ID`. These adoption inputs are only needed for existing resources; a fresh Sandbox can create its catalog without generated IDs. Attached meter-credit benefits need no separate prerequisite IDs. Incompatible or ambiguous resources stop setup; unrelated public recurring products require operator disposition and are never archived automatically.

Seed and start a separately selected web database with the same `DATABASE_URL`. Once startup records that choice, later commands and fixtures use its completed connection record. A fresh database requires an explicit seed before signing in; starting another process against an already seeded database needs no new fixture operation. Replacing checkout-local runtime state must preserve other databases and the shared Polar account under the [machine-ownership rules](AGENTS.md#the-machine-is-shared-own-only-what-you-created).

### Start and sign in

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start local web, platform, viewer auth and dispatcher using the shared baseline. Keep it running while developing or running tests against the DevEnv. |
| `pnpm dev --polar-listen` | Start the same services with explicit Polar Sandbox webhook forwarding for webhook development and verification. |
| `pnpm dev:ctx <args>` | Run the built CLI against this DevEnv with its checkout-local saved login. |
| `pnpm dev:env` | Print shell-safe connection settings for another command. Use them in a subshell. |

`pnpm dev` builds workspace dependencies, starts both checkouts' Compose Postgres services without recreating running containers, creates the selected logical databases if absent, and applies each application's migrations. Startup imports the fixed public client ID, prints the selected service URLs and saves both database selections in the completed connection record. It creates no shared identities, catalog resources, customers or subscriptions and performs no Polar catalog discovery. Ordinary billing reads and direct usage ingestion still contact Polar. Forwarding is off by default; `--polar-listen` runs native `polar webhook listen` for this platform without a tunnel. That listener observes the entire Sandbox organization, so enable it deliberately and stop it with its owning DevEnv when finished. New local signups receive Free only when their customer-created webhook is delivered; normal development uses the shared Unlimited owners.

Use your regular browser at the printed web URL and sign in with the development email and password in [the fixture](packages/dev-env/seed.json). **Sign out of any other localhost account before opening a CLI device link.** In another terminal:

```sh
pnpm dev:ctx login
pnpm dev:ctx whoami
```

Approve the device request in that same browser session. Better Auth binds a device code to the first signed-in user who opens it; if another account claimed the code, switch accounts and start a fresh login. Keep the baseline session for ordinary development and CLI approvals. Open `/dashboard/personal/slates` at the printed platform URL for dashboard development.

For a second identity against the same DevEnv, run the built CLI inside a `dev:env` subshell with `CTX_CONFIG_DIR` pointing at another directory, impersonate the intended user in web, and approve that device code there. Each directory holds one login. CLI `--help` prints the selected issuer, client, platform URL and config directory; `whoami` verifies the identity.

### State, isolation and shutdown

| State | Location and lifetime |
| --- | --- |
| Initialized connection settings | This checkout's ignored `.env.json`, written after service readiness and retained after shutdown. `dev:ctx`, `dev:env` and DevEnv test fixtures read it automatically. |
| CLI login | This checkout's `.contextlayer/cli`, selected by the DevEnv runners and fixtures independently of an inherited personal config directory. |
| Platform database | `<checkout folder>_platform` on the server selected by `CTX_PLATFORM_DATABASE_URL`; the main checkout uses `contextlayer_platform`. Startup records the selected database URL in `.env.json`. |
| Web source | Sibling `../web`, shared by the running web processes; generated development output is separated by port. |
| Web database | Selected by `DATABASE_URL` and recorded in `.env.json`; defaults to `postgresql://postgres:postgres@127.0.0.1:5489/contextlayer_web`. DevEnvs may share it or select independent databases seeded with the same fixture. |
| Cloudflare resources | Remote `contextlayer-test` repositories and user Workers, shared infrastructure even though the services run locally. |

Startup selects four available ports of at least 3000 for web, platform, viewer auth and dispatcher. It reuses the complete saved set only when all four still meet that minimum and are free; otherwise it selects a new set. **If the web port changes, run `pnpm dev:ctx login` again: the saved credential belongs to the previous issuer.**

Changing the selected web database also requires a fresh CLI login: sessions, grants and signing keys belong to that database even when its fixture user and client IDs match another database.

Polar overrides must have the same values in every terminal using that DevEnv. Another terminal does not inherit variables supplied only to startup, and the checkout record does not carry provider overrides. The web database selection is retained in the record.

Ctrl+C stops the DevEnv and exits successfully. An owned service exiting also stops startup; an explicitly enabled listener belongs to that same lifetime. Shared Postgres services remain subject to the [machine-ownership rules](AGENTS.md#the-machine-is-shared-own-only-what-you-created): never stop or reset them as part of session cleanup.

Local Durable Object identities and state are scoped to their effective persistence directory. Restarting with the same directory preserves them; another directory is isolated. State stored under different namespace keys is not migrated automatically. Let Miniflare and Wrangler clean up the containers and development image tags they own on shutdown. Docker image content can be shared across sessions; it is not evidence of session ownership and must not be pruned as session cleanup.

### Commands in another directory or terminal

Once initialization completes, obtaining command settings requires only the checkout's completed connection record: no Doppler download, web database lookup or client-discovery subprocess. This guarantee applies to composing command settings; the command being run may need its own service access.

`dev:ctx` preserves the directory pnpm was invoked from: `pnpm -C <path-to-this-checkout> dev:ctx …` acts on the current directory from anywhere. For an arbitrary command, `dev:env` supplies service URLs, platform and web database URLs, issuer/client settings, the checkout-local login directory and the CLI invocation used for Git authentication and login repair. It does not export access tokens, baseline credentials, Polar overrides or the applications' Doppler secret sets.

`dev:env` writes shell assignments to stdout and diagnostics to stderr. Use its output directly with `eval`, without `--silent`, in a subshell so the parent shell stays unchanged:

```sh
(ctx_env=$(pnpm dev:env) && eval "$ctx_env" && python my-script.py)
```

For database changes, follow [Platform database migrations](#platform-database-migrations). For running platform independently of the DevEnv, use its [local runtime instructions](packages/platform/AGENTS.md#local-runtime).

### Faux worktrees and change summaries

A faux worktree is a sibling clone made by `setup-faux-worktree <existing_folder> <new_branch>` and removed by `close-faux-worktree`; it has its own `.git`, so Git worktree commands do not apply. Always ask before creating one for a spec. One worktree per spec is the usual shape described in [PRODUCT-DEVELOPMENT-v1.md](prompts/PRODUCT-DEVELOPMENT-v1.md).

Run its DevEnv as from any checkout, with the [state boundaries above](#state-isolation-and-shutdown). Closing the worktree does not drop its platform database.

`/describe-changes` narrates a range's actual behavior and files. `/close-faux-worktree` owns the landing sequence: current CI-equivalent gates plus all local integration tiers before merging. Account for every failure and skip; do not silently drop a landing gate.

## Developing with a local slate

A slate created against the DevEnv is the ordinary development loop for the issuer, platform, CLI and SDK together: run the slate's own dev server against the DevEnv. With the DevEnv running and its [CLI login established](#start-and-sign-in), build the CLI and create a slate outside this repository:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/cli
pnpm dev:ctx init ../my-slate
```

The slate is registered in the local platform and appears in its dashboard. Use `pnpm dev:ctx init --help` for organization selection. Create slates outside this repository so they have an independent Git root and package-manager workspace. pnpm must work there too; a machine-wide mise default supplies it outside repo-local tool configuration, without `mise exec` or a CLI workaround.

Run `pnpm exec turbo run dev:watch --filter=@usecontextlayer/cli` to rebuild the CLI and starter as their source changes. **Rebuilding does not update an existing slate's files; initialize a fresh slate to exercise starter edits.** Before running a slate against unpublished CLI or SDK changes, [install matching local packages](TESTING.md#verifying-unpublished-cli-and-sdk-in-a-slate-checkout). `dev:ctx` selects this workspace's CLI, but the slate's Vite integration uses its installed packages.

Commands that act on a slate checkout read the current directory. Run them from inside that checkout through this repository's DevEnv runner:

```sh
cd ../my-slate
pnpm -C <path-to-this-checkout> dev:ctx connections local assign <slug> <account_id>
```

Start the slate's own dev server inside a `dev:env` subshell so Vite finds the DevEnv's issuer, client and login:

```sh
(ctx_env=$(pnpm -C /path/to/contextlayer-checkout dev:env) && eval "$ctx_env" && pnpm dev)
```

### Local slate resources

Follow [Local login and assignment](docs/reference/sdk.mdx#local-login-and-assignment) for the checkout's declarations, resource inputs and persistent state. Hosted assignments and vault values do not supply local inputs.

Listing local requirements needs no Git metadata, login, running development server or platform request.

Restart the slate's `pnpm dev` after declaration, assignment or secret changes, and when its startup access token expires. Keep the generated `workers/local-resources` files current with the CLI template when updating a development checkout. [Local verification](TESTING.md#local-slate-resources-and-agents) owns checks against the running app.

### Running an agent locally

Build the CLI with `pnpm exec turbo run build tsc --filter=@usecontextlayer/cli`. From a slate checkout containing `agents/<name>/instructions.md`, run `pnpm -C <path-to-this-checkout> dev:ctx agent --help` for local-run commands. Claude Agent SDK uses native Claude authentication, so an existing Claude login or SDK-supported model credential must be available. The command starts and stops the slate's development server and uses its persisted `.contextlayer/databases` state. App connection declarations require the matching saved CLI login; declarations with only databases need no ContextLayer login.

[Local agent execution](ARCHITECTURE.md#local-agent-execution) owns instruction composition and settings isolation. Follow [local agent verification](TESTING.md#local-slate-resources-and-agents) to exercise changes.

### Authored database development

Follow [Add a database](docs/how-to/add-a-database.mdx) for declarations, native Kysely migrations, type generation, and the local apply/restart/commit workflow. These are slate databases, separate from the [platform Postgres database](#platform-database-migrations). Publish committed migrations through [slate deployment](#slate-deployment); [membership provisioning](ARCHITECTURE.md#membership-creation-and-provisioning) covers newly added members.

### Git source pushes

After logging in through the DevEnv, commit the slate changes and push from its checkout:

```sh
git push origin HEAD:main
```

**A DevEnv push stores source in `contextlayer-test`; it does not trigger a Cloudflare build or deployment.** Production publication follows [Slate deployment](#slate-deployment).

CLI login registers Git's credential helper for this OS user, once per platform URL for all its slates. Subsequent pushes use the recorded login settings independently of the terminal's `CTX_*` variables. DevEnv registrations require this checkout and its built CLI to remain available. Run login again to replace the registration, select a newer public CLI release, or change the saved login used for that platform. Login and init must target the same platform URL so the helper's URL scope matches the remote. Git requires native `authtype` credential support. [CLI authentication](ARCHITECTURE.md#cli-authentication) owns the helper and credential-storage contract.

### Slate chrome development

Use the [App Layout reference](docs/reference/sdk.mdx#app-layout) for `Layout` integration and the [chrome architecture](ARCHITECTURE.md#slate-chrome) for its boundary. Chrome verification requires a hosted slate: follow [cross-site chrome and viewer sessions](TESTING.md#cross-site-chrome-and-viewer-sessions). Configure hosted personal inputs in the chrome; there is no separate join command.

## Configuration and migrations

### Platform database migrations

DevEnv startup applies pending platform Postgres migrations without regenerating source. To migrate and regenerate Kanel types against that same selected database, run from the initialized repository checkout:

```sh
(ctx_env=$(pnpm dev:env) && eval "$ctx_env" && pnpm exec turbo run db.latest --filter=@usecontextlayer/platform)
```

The migration command reads `CTX_PLATFORM_DATABASE_URL`. **A bare `doppler run -p platform -c dev -- …` can select a different database from the one startup recorded.** Use the initialized command environment when targeting this DevEnv. Production platform migrations run separately from Worker deployment; apply pending migrations before running the corresponding application version against an existing database.

### OAuth registration and migration

Follow the [resource and scope contract](ARCHITECTURE.md#oauth-resources-and-scopes). Keep the issuer, client registration and consumers in the same environment. Local initialization uses local web and the checkout's completed `.env.json`; the service address does not change the canonical platform OAuth resource. CLI issuers require HTTPS except on localhost/127.0.0.1.

For a new environment, register resources and the public CLI client through Better Auth's native operations, link the client to the platform resource, and allow the device-code and refresh-token grants with `platform:access` and `offline_access`. Let normal CLI device login and MCP authorization issue credentials.

For an existing environment, inspect native resource registrations, client scopes and client-resource links before proposing changes. Coordinate caller/verifier changes with registration updates, including resource `allowedScopes`, while preserving `offline_access`. **Source edits do not update registrations or saved grants.** Remote configuration changes require the operator's approval for each write. Re-run CLI login and MCP authorization afterward. The shared provisioning secret is configured under [DevEnv](#prerequisites-and-configuration) for local use and [Service deployment](#service-deployment) for production.

### Polar configuration

For production, register a Polar endpoint for `customer.created` and `customer.state_changed`, API version `2026-10`, at platform's `/api/polar/webhooks`. Store its signing secret as `POLAR_WEBHOOK_SECRET` in Doppler `platform/prod`, alongside `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT=production`, `POLAR_FREE_PRODUCT_ID` and `POLAR_CLIPS_METER_ID` for the matching production catalog. Configure a recurring Free product with a fixed zero price, no metered price and the native non-rollover Clips credit benefit. Apply platform database migrations before verifying billing state, and deploy both platform and dispatcher through [Service deployment](#service-deployment).

Polar locks pricing type at creation. Replacing a metered Free product requires creating a genuine Free product and attaching the native credit benefit. Archive the replaced catalog entry so new customers see the intended Free plan. **Catalog replacement does not migrate existing subscriptions: they retain their native prices and benefits.** Inspect those subscriptions separately before changing a catalog product.

[DevEnv](#prerequisites-and-configuration) owns Sandbox configuration and webhook forwarding; [Polar testing guidance](TESTING.md#polar-sandbox) owns verification and provider-state ownership. Sandbox tests do not configure production or deploy services. External configuration changes remain user-owned.

## npm releases

Use the release tool's help for commands, options and stopping points:

```sh
node --import tsx scripts/release.ts --help
```

Main pushes run checks; version-tag pushes publish npm packages. Use the release ladder to keep the version, checked commit and release tag together. Tag publication requires successful checks for that exact commit and package versions matching the tag. The ladder commits and pushes; follow the machine's Git approval convention. GitHub receives `NPM_TOKEN` for publication and `FONTAWESOME_PACKAGE_TOKEN` for CI installation through Doppler sync. Package manifests own which packages publish. npm publication and service deployment have separate workflows, but the release ladder also pushes main and can therefore trigger [Workers Builds](#service-deployment). Twilio deployment remains separate.

For public CLI onboarding and deployment, follow the [CLI README](packages/cli/README.md) and the generated checkout's README. Public setup uses `npx @usecontextlayer/cli` without a global installation.

## Service deployment

Cloudflare Workers Builds deploys ContextLayer's Workers from `main` in `usecontextlayer/contextlayer`, with repository root `/`. Configure each Worker with the shared root script, using its package name (`platform`, `dispatcher`, `auth`, `build`, or `mcp-microsoft-planner-premium`):

```sh
bash scripts/cloudflare.sh build <package>
bash scripts/cloudflare.sh deploy <package>
```

Workers Builds reads the root `.node-version`; remove any separate `NODE_VERSION` override. Set `PNPM_VERSION` to the pnpm version pinned by the repository, `SKIP_DEPENDENCY_INSTALL=true`, and `WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST=1` in each build configuration. The last setting lets Docker image builds use the runner's host network. Registry authentication must be available before dependency installation.

Supply a config-scoped read-only token for Doppler `platform/prod` as the Cloudflare build secret `DOPPLER_TOKEN`. Capture its value when creating it; later token listing/get calls return metadata without the credential. Doppler supplies `FONTAWESOME_PACKAGE_TOKEN` for installation. Keep both bootstrap and registry credentials in the build environment; neither belongs in runtime Worker bindings.

Follow the [secret-delivery contract](ARCHITECTURE.md#worker-deployment-and-secrets): declare runtime secret names through Wrangler's native `secrets.required` and keep their values in Doppler. The shared deployment workflow resolves the effective configuration, including Vite's generated configuration. Do not maintain a `.dev.vars` copy or a separate secret list. Changed Doppler values take effect on the next deployment.

Production platform serves at `https://platform.usecontextlayer.com`. Its database configuration belongs in Doppler `platform/prod`; Neon's `platform` project owns the production database. Run [platform migrations](#platform-database-migrations) separately from Worker deployment. Slate OAuth provisioning requires the same `CTX_APP_OAUTH_PROVISIONING_SECRET` in Doppler `platform/prod` and `web/prod`.

For Planner-specific service configuration, use its [deployment instructions](packages/mcp-microsoft-planner-premium/AGENTS.md#deployment). The [Twilio README](packages/twilio/README.md) owns Twilio configuration and deployment.

### Build Worker

Follow [Build deployment configuration](packages/build/AGENTS.md#deployment-configuration) for Docker, namespace, bucket and credential prerequisites.

Before deploying Build, platform must export the named `Provisioning` entrypoint with `prepare` and `provisionSchedules`. Platform's `MEMBER_PROVISIONING` Workflow binding targets Build's `ProvisionSlateMember`; Build's `DATABASES` binding targets platform's `SlateDatabase`. Both Workers must have their corresponding classes deployed before slate provisioning runs.

Deploy Build with its named `Inspection` entrypoint before deploying platform with the `INSPECTION` service binding. `CTX_CI_WORKFLOW` must select the Workflow configured in that same Build environment. [Native inspection prerequisites](TESTING.md#cloudflare-test-resources) explain the distinction between local Worker execution and remote Workflow records.

### Dispatch Worker

Platform must export the named `Execution` entrypoint before deploying dispatcher with its `EXECUTION` service binding.

Follow [Dispatcher deployment configuration](packages/dispatcher/AGENTS.md#deployment-configuration) for namespace setup, wildcard DNS and runtime service targets.

### Viewer auth Worker

Web must expose `/viewer/sign-in` and enable Better Auth's one-time-token and bearer plugins before deploying auth and dispatcher.

Follow [Auth deployment configuration](packages/auth/AGENTS.md#deployment-configuration) for route specificity, issuer and domain settings, and the callback destination shared with web and dispatcher. Use [viewer-session verification](TESTING.md#cross-site-chrome-and-viewer-sessions) to check the combined flow.

## Slate deployment

Push committed source from a checkout created against the intended platform through its `/git/<slate-id>` remote. In production, pushes to `contextlayer-prod` Artifacts trigger the deployed build Workflow. Use published CLI and SDK packages for production hosted slates; unpublished packages belong in [local/test verification](TESTING.md#verifying-unpublished-cli-and-sdk-in-a-slate-checkout).

Follow the [deployment guide](docs/how-to/deploy.mdx) to inspect CI and the published revision after a push; use the [DevEnv command runner](#start-and-sign-in) for local inspection. Operators with Cloudflare account access can also open Workflows → `contextlayer-build` in the Cloudflare dashboard. Inspect `build`, `migrate`, and `deploy` in order, followed by schedule provisioning. Build output and status show whether the pushed commit built; a successful build includes its CI snapshot. **A failed migration stops deployment and is not automatically retried; earlier successful SQL statements may remain applied.** Migrations must remain compatible with the currently deployed Worker until publication completes. [Build and publication](ARCHITECTURE.md#build-pipeline) owns phase ordering and revision coherence.

Inspect background membership provisioning in `contextlayer-member-provisioning`, or its `-test` counterpart during development. Membership is established before that Workflow finishes. A slate-creation provisioning failure can roll back SQL while leaving its Artifacts repository; inspect the actual resources before proposing cleanup.

### Deploying and inspecting an agent

Commit `agents/<name>/instructions.md` and keep `public/slate.json` and every `agents/<name>/slate.json` valid. Declare schedules in `agents/<name>/schedules/<prompt>.md` with YAML frontmatter such as `cron: "0 7 * * 1-5"` and the user prompt in the Markdown body. Cron is canonical five-field UTC. Push through the normal slate deployment workflow to publish changes and provision schedules.

Follow platform guidance for [hosted model configuration](packages/platform/AGENTS.md#hosted-model-configuration), [Authored agents](ARCHITECTURE.md#authored-agents) for inspection and authorization semantics, and [model-test prerequisites](TESTING.md#provider-accounts-and-model-credentials) for verification.

## Operational tools

### Doppler

Local platform and deployed-service configuration live in the ContextLayer workplace. Authentication is directory-scoped and case-sensitive: run `doppler me` before use and stop if it reports another workplace or no scoped token. Do not borrow a token or log in ad hoc to bypass a missing directory scope.

Pass project and config explicitly with `doppler run -p <project> -c <config> -- <cmd>`. Follow the root [Doppler permission rule](AGENTS.md#operating-the-repo) before changing configuration.

Configs inherit values from their environment's root config and override only local settings. Set shared values at the root rather than duplicating them in branch configs. A branch's secret listing includes inherited values, so presence does not establish that the value was set on that branch.

### Cloudflare and Fly.io

Use `npx cf` for Cloudflare resource operations and the [shared deployment workflow](#service-deployment) for the repository's Workers. Configuration stays in Wrangler's format; `cf` configuration cannot represent Build's Artifacts push-event triggers.

Fly commands must target the `contextlayer` organization: pass `--org contextlayer` where supported, and verify with `fly orgs list` or the app's `fly status` before any mutation. Do not create an app as a side effect. Keep Fly deployments to one machine (`--ha=false` when creating machines); changes beyond a plain deploy require discussion with the user.

### Sentry

Sentry org `803-inc` owns the reporting projects; `sentry project list` is the live inventory. Use the retained Sentry skills for CLI operations, error triage, and instrumentation; they do not authorize changing the remote service.

When interpreting telemetry, sampling means counts are not traffic rates; span start order does not establish dependencies, and overlapping spans must not be summed as elapsed user wait. Attribute subprocess spans by working directory, not just command name. For streamed responses, HTTP 200 alone does not prove a successful render.

### Skills

Third-party skills are owned by `npx skills` and `skills-lock.json`; never hand-edit installed skill content or the lock. `.agents/skills` is the store and `.claude/skills` is the view. Reconcile the view with `skills-sync`, without hand-maintaining symlinks. Keep installed content's upstream formatting; format and verify changed lock/config files, and commit those formatting changes with the skill update.

## Troubleshooting

The user permits pnpm to rebuild `node_modules` when installation requires it. In a non-interactive shell, use `CI=true` to accept that operation.

Run commands directly (`pnpm`, `npx`, `node`); do not prefix them with `mise exec`. Mise supplies installed versions through the shell environment. If a command reports a runtime or version error, stop and ask before changing the environment or invocation. Keep the enforced version floor.

Run a failing Turbo task alone to read its output. For cleanup, follow the root [machine-ownership rules](AGENTS.md#the-machine-is-shared-own-only-what-you-created).
