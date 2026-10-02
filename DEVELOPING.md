# Developing

This workspace contains seven private packages, including the platform application. Use the root package scripts and Turbo for libraries and applications. Both GitHub workflows are manual-only.

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

## CLI development

Build the local `ctx` executable, then invoke the built executable from the repository root:

```sh
pnpm exec turbo run build --filter=@usecontextlayer/ctx
pnpm ctx --version
pnpm ctx init my-react-router-app
```

`ctx init <directory>` uses the official Cloudflare React Router scaffold through `pnpm create cloudflare@latest`, accepting defaults, initializing Git, and disabling deployment. The generated project owns its `pnpm dev` and `pnpm build` commands; its Cloudflare Vite plugin runs server code in the Workers runtime. After scaffolding, it creates an app through `POST /api/apps`, then sets `origin` to `<CTX_PLATFORM_URL>/git/<app-id>`. The platform assigns an immutable UUID and a friendly public hostname. `CTX_PLATFORM_URL` is read in the CLI's `env.ts` and defaults to `http://localhost:3010`. Initialization does not push. Relative directories resolve from the calling directory. The version comes from `packages/cli/package.json`. Run `pnpm exec turbo run dev:watch --filter=@usecontextlayer/ctx` to rebuild the CLI as its source changes.

## Platform development

Platform needs Node 24.19+, a migrated Postgres database, and access to a Cloudflare Artifacts namespace. Set `CTX_PLATFORM_DATABASE_URL` to the platform-owned database. `CTX_APPS_DOMAIN` defaults to `contextlayer.xyz`; generated hostnames use this suffix. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Artifacts read/edit access), and optionally `CTX_ARTIFACTS_NAMESPACE` (defaults to `contextlayer-dev`). Credentials are read through `packages/platform/app/env.ts` and remain on the server. Create the namespace before starting the platform.

Use `pnpm dev:watch` for UI development with Vite autoreload. Run `pnpm dev` from the repository root to build and start the platform at `http://localhost:3010/dashboard/apps`. Run `pnpm dev:watch` for React Router/Vite watching. `CTX_PLATFORM_PORT` selects the production server port; Vite uses its own `--port` option. Provision a separate logical platform database on the shared Postgres instance before starting. Run `pnpm exec turbo run db.latest --filter=@usecontextlayer/platform` to migrate and regenerate Kanel types. The server consumes the configured database; it does not create or migrate it during startup.

Run `ctx init <directory>` against the running platform, then push the project's commit with `git push origin HEAD:main`. The app appears at `/dashboard/apps` immediately after initialization. The Git remote uses the app UUID permanently. `/git/...` proxies Git traffic using repository-scoped tokens held by the server. `GET /api/apps` returns `{ "apps": [{ "id": "…", "public_hostname": "…", "latest_commit": "…" }] }`; `/api/openapi.json` describes creation, listing, and hostname resolution. `GET /api/apps/resolve?hostname=<public-hostname>` returns the matching `{ "id": "…" }`, or HTTP 404 when unassigned. Listing reads the latest commit on main directly from Artifacts; latest_commit is null before the first commit. The dashboard shows its seven-character SHA beneath the app link. The Git endpoint and dashboard are currently unauthenticated; access control is a later milestone.

The platform integration test provisions its own database, starts the built server, creates an app through the real API, checks listing and rendering, pushes and clones through its UUID remote, and pushes an update. It deletes its own Artifacts repository and database. It requires Cloudflare configuration and the shared local Postgres instance:

```sh
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform
```

The dashboard uses the private Font Awesome npm kit described in `packages/platform/.font-awesome.md`. The repository maps its npm scopes in `.npmrc`; configure the Font Awesome package token in your user npm configuration before installing dependencies. Never commit that token.

## Build Worker

`packages/build` owns the Cloudflare CI pipeline. Build and typecheck it from the repository root with `pnpm exec turbo run build tsc --filter=@usecontextlayer/build`. Building the configured Sandbox image requires Docker. The worker uses Wrangler directly because the current `cf` configuration cannot represent Artifacts push-event triggers.

The `contextlayer-build-backups` R2 bucket stores SDK workspace snapshots. Supply bucket-scoped Object Read & Write credentials as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the ignored `packages/build/.dev.vars`. Deploy from `packages/build` with `pnpm exec wrangler deploy --secrets-file .dev.vars` using a Cloudflare identity authorized for the configured account. These are snapshot credentials. Supply a Workers deployment API token as `CF_TOKEN` in the same ignored file. The SDK passes it only to the chained deployment runner, not the build runner.

Push a project created by `ctx init` through the running platform’s Git endpoint. In the Cloudflare dashboard, open Workflows → `contextlayer-build` and inspect the new instance’s `build` step. Its command output and status show whether the pushed commit built; a successful result includes the SDK’s workspace snapshot. Cloudflare account access is required to inspect these runs. The chained `deploy` step uses Wrangler to upload the built Worker and client assets to WfP under the AppID. Inspect both steps to confirm deployment.

## Dispatch Worker

Build and typecheck with `pnpm exec turbo run build tsc --filter=@usecontextlayer/dispatcher`. Deploy from `packages/dispatcher` with `pnpm exec wrangler deploy`, using an identity authorized for the configured Cloudflare account. The user approved Wrangler for both Workers. The `contextlayer-dev` WfP namespace must exist before deployment.

The wildcard DNS record for `*.contextlayer.xyz` is proxied. Wrangler attaches that route to `contextlayer-dispatcher`. Set `CTX_PLATFORM_URL` in its Wrangler configuration to a reachable platform URL. The current local setup uses `ngrok http 3012 --log stdout`; the user explicitly approved exposing the full unauthenticated platform through this temporary tunnel. Update the configured URL and redeploy if the tunnel address changes. Keep the platform and tunnel running while testing public app requests.

## Tests and local Postgres

`pnpm test` runs the unit tier. `AGENTS.md` and `vitest.shared.ts` define the Node/browser runtimes and node/browser/Claude integration tiers. CI runs unit tests; integration tests are opt-in. The current packages have Node unit tests in shared and Node integration tests in db-infra (Postgres) and platform (Cloudflare Artifacts); browser and Claude tasks remain available for future package tests.

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

Use the release tool's help for its commands, options, and stopping points:

```sh
node --import tsx scripts/release.ts --help
node --import tsx scripts/release.ts audit
node --import tsx scripts/release.ts verify
```

The release ladder bumps package versions and the lockfile, commits and pushes, dispatches and watches `check.yml`, then pushes the version tag and dispatches `release.yml`. Its final rung watches the release run. Both workflows require explicit dispatch; pushes and tags alone start neither. All current packages are private, so the npm publish list is empty. The release workflow still includes the existing Twilio deployment job; a real release is an external action.

`packages/twilio/README.md` owns its service configuration and deployment details. The old product deployment stack is absent; do not recreate its images or services as part of routine setup.

## Faux worktrees and change summaries

A faux worktree is a sibling clone made by `setup-faux-worktree <existing_folder> <new_branch>` and removed by `close-faux-worktree`; it has its own `.git`, so Git worktree commands do not apply. Always ask before creating one for a spec. One worktree per spec is the usual shape described in `PRODUCT-DEVELOPMENT-v1.md`.

`/describe-changes` narrates a range's actual behavior and files. `/close-faux-worktree` owns the landing sequence: current CI-equivalent gates plus all local integration tiers before merging. Account for every failure and skip; do not silently drop a landing gate.

## Skills

The third-party skills are owned by `npx skills` and `skills-lock.json`; never hand-edit installed skill content or the lock. `.agents/skills` is the store and `.claude/skills` is the view. The skill store is excluded from root Biome checks so installed content keeps its upstream formatting. Reconcile the view with `skills-sync`, without hand-maintaining symlinks. After a skills operation, format the changed lock/config files and verify formatting; include those formatting changes alongside the skill update when committing.

## Doppler

Deployed configuration lives in the ContextLayer workplace. Authentication is directory-scoped and case-sensitive: run `doppler me` before use and stop if it reports another workplace or no scoped token. Do not borrow a token or log in ad hoc to bypass a missing directory scope.

Pass the project and config explicitly with `doppler run -p <project> -c <config> -- <cmd>`. Reads are fine; creating or changing projects, configs, or secrets is user-territory. Propose the exact change to the user.

Configs inherit values from their environment's root config and override only their local settings. Set shared values at the root rather than duplicating them in branch configs. A branch's secret listing includes inherited values, so presence does not establish that the value was set on that branch.

## Cloudflare and Fly.io

For Cloudflare operations, use `npx cf`; configuration stays in Wrangler's format. The Workers in `packages/build` and `packages/dispatcher` use `pnpm exec wrangler` for build and deployment, as explicitly approved by the user. The current `cf` configuration cannot represent the build Worker’s Artifacts push-event triggers. Fly commands must target the `contextlayer` organization: pass `--org contextlayer` where supported, and verify with `fly orgs list` or the app's `fly status` before any mutation. Do not create an app as a side effect. Keep Fly deployments to one machine (`--ha=false` when creating machines); changes beyond a plain deploy require discussion with the user. These conventions do not imply that this repo currently owns a running Fly app.

## Sentry

Sentry org `803-inc` owns the reporting projects; `sentry project list` is the live inventory. Shared retains the tested Sentry event-cap helper. There is no application telemetry host in this workspace. Use the retained Sentry skills for CLI operations, error triage, and instrumentation; they do not authorize changing the remote service.

When interpreting telemetry, sampling means counts are not traffic rates; span start order does not establish dependencies, and overlapping spans must not be summed as elapsed user wait. Attribute subprocess spans by working directory, not just command name. For streamed responses, HTTP 200 alone does not prove a successful render.

## Troubleshooting

The user permits pnpm to rebuild `node_modules` when installation requires it. In a non-interactive shell, use `CI=true` to accept that operation.

Run commands directly (`pnpm`, `npx`, `node`); do not prefix them with `mise exec`. Mise provides the installed tool versions through the shell environment. If a command reports a runtime or version error, stop and ask before changing the environment or invocation. Keep the enforced version floor.

Run a failing Turbo task alone to read its output. Shared-machine cleanup requires exact ownership: stop only your own PIDs and reclaim only your own databases. Report resources of uncertain ownership and ask before removing them.
