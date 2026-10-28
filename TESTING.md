# Testing

This document owns the repository's shared testing model: what a test proves, where it belongs, how it uses production code and real dependencies, and who owns its resources. Its purpose is conceptual integrity: new tests should reinforce the same model rather than introduce a competing one. Preserve the reasons and boundaries behind each rule when extending the suite.

[ARCHITECTURE.md](ARCHITECTURE.md) owns product contracts; [DEVELOPING.md](DEVELOPING.md) owns the DevEnv; [AGENTS.md](AGENTS.md) owns shared-machine and customer-data permissions. Test names and assertions own the executable coverage. Keep non-obvious scenario prerequisites and hazards beside the test or fixture they constrain; do not maintain prose copies of test bodies here. [Documentation guidance](AGENTS.md#documentation) defines documentation ownership.

## Testing principles

Review test changes with [tests-pin-behavior](.agents/checks/tests-pin-behavior.md), which judges what the assertions prove, and [tests-reuse-production](.agents/checks/tests-reuse-production.md), which judges how the test reaches production. The principles below explain the shared model; those checks apply it to changes. Neither check prescribes suite organization or demands additional coverage.

### Test-First Is Opt-In

**Implement directly and cover with tests where the repo's conventions call for them; do not run the red→green ceremony by default.** Reach for test-first when the user asks for it on a task, or when a failing test is the cheapest proof that a subtle defect (a concurrency or ordering bug) is real. The ceremony costs real wall-clock on mechanical changes and earns its place only where the failing test is itself the evidence. A general standard that mandates test-first everywhere does not override this repo's stance.

### Placement & Tiers

Tests are sorted by a **filename suffix** along two orthogonal axes defined in `vitest.shared.ts`: the **runtime** (plain Node or Chromium) and the **tier** (unit = hermetic, runs on CI; integration = needs a real local prerequisite, opt-in only). **The unmarked name claims the default runtime: bare `*.test.ts(x)` runs in plain Node.** `.browser.` marks browser-coupled tests. Write a bare unit test unless it needs one of those runtimes or an integration prerequisite.

**All tests should be behavioral; integration is a dependency requirement, not a separate standard of assertion.** Choose integration when the promise requires a real service or runtime boundary: Postgres constraints need Postgres, and Worker bindings need the native Worker runtime. Logic observable through a hermetic public contract stays in the unit tier.

| Filename | Runtime / tier | Turbo task | Per-package config | What belongs here |
| --- | --- | --- | --- | --- |
| `*.test.ts(x)` | Unit, Node | `test` | `vitest.config.ts` | Hermetic logic, local subprocesses/filesystem, and real Git fixtures over temporary directories |
| `*.browser.test.ts(x)` | Unit, Chromium | `test` | Browser project in `vitest.config.ts` | DOM rendering, browser globals, storage, and browser-only modules |
| `*.node.integration.test.ts(x)` | Node integration | `test:integration:node` | `vitest.integration.node.config.ts` | A real local service such as Postgres, or a real guest |
| `*.browser.integration.test.ts(x)` | Browser integration | `test:integration:browser` | `vitest.integration.browser.config.ts` | A real browser with a real local service behind it |
| `*.claude.integration.test.ts(x)` | Claude integration | `test:integration:claude` | `vitest.integration.claude.config.ts` | Real Claude with its required credentials |

**CI runs only the unit tier**, including any browser unit projects. The three integration tiers are opt-in/local-only; anything that must be covered in CI belongs in a unit test. Never move a test to a heavier tier for convenience and thereby give away its CI coverage.

A package carries a tier's config and script only when it uses that tier. Unit configs exclude the integration markers through `unitTestExclude`; only a package that actually runs browser tests may exclude that runtime's marker from its Node unit project. Misplaced tests therefore run in Node and fail instead of silently disappearing. When adding the first test of a tier, add the matching per-package config and task using the includes exported by `vitest.shared.ts`.

### Assert on the Contract, Not the Inside

**A test earns its place by being invariant to the inside and sensitive to the promise: refactor the implementation freely and the test does not move; change what the unit promises and it breaks.** Both halves are load-bearing — a test that survives every refactor because it asserts nothing has the property vacuously and guards nothing.

**The discipline that produces it: drive and observe a unit only through its public contract, never through its inside.** The inside is the implementation — internal helpers, private intermediate state, the sequence of calls a function makes on its way to an answer, the shape of a structure that never leaves. A test that reads any of those is a second copy of the implementation, and a copy has the inverse of a test's value: it cannot fail when the promise changes (its only job), and it always fails when the code is reshaped (never its job).

**This is what makes reshaping affordable.** Making a hard change easy before making it assumes the reshape is cheap, and it is only cheap while the suite does not move with it — a suite that mirrors implementation makes refactoring MORE expensive than having no suite at all, because you pay to rewrite assertions that were never testing anything real, and the bill lands on every later change rather than on the one that added them.

**You pick the unit; the rule is only that you do not reach inside the one you picked.** "Contract" is not a synonym for "end-to-end" — a single-function test is fully in-contract when it drives that function's arguments and asserts its return. This rule never argues for a bigger test or a heavier tier; `Placement & Tiers` decides that.

**Production code never grows a seam for a test.** A `*ForTest` export, a test-only branch, or a cross-layer hook that exists so a test can see inside is the white-box defect billed to the shipping artifact. A unit that cannot be exercised through its contract is too coupled — inject the dependency at an idiomatic boundary, or the unit is the wrong size. Fix the design; never widen the visibility.

**Tests reuse production; they never grow a parallel implementation.** A test, fake, fixture, or harness carries no rule that production or another system owns: no expected value computed by copying or calling the algorithm under test, no fake enforcing the rules of what it stands in for, no stand-in host running production code along a path production never takes. Choose the idiomatic production shape before cutting coverage: drive the framework's intended boundary and the existing production path, or reshape production so production and the test call one function. That reshape is not a seam — a seam is a knob only tests turn; a shared function is one production itself calls. A literal that pins the contract or a property that asserts an invariant is not a parallel implementation; re-running the logic that produces the answer is. When no production path reaches the case, leave it untested: an uncovered case costs less than a parallel implementation.

**A test double neither satisfies nor violates this rule.** It is in-contract when it stands at a boundary and the assertion reads the far side; out-of-contract when the assertion reads the double's own call log, which is our code's inside seen through a stand-in. When the far side cannot be observed through the real path, assert less — never teach the double the real system's rules so it has something to reject. Whether a double belongs there at all is `Exercise the Real Dependency`.

**Keep the operation under test in the test body.** Fixtures and global setup supply prerequisites; they never perform the action being verified, because a test whose subject runs in setup has nothing left to assert.

### Exercise the Real Dependency

**Where a dependency is real, the test drives the real thing.** A hand-authored payload — an SDK event, an API response, a stream ordering — is an assertion about somebody else's contract, written from memory: it cannot fail when that contract changes, which was its only job. It looks like coverage and is the opposite. Completeness does not rescue it: a payload hand-authored from the docs with every field filled in is the same frozen guess wearing more detail, and it reads as more authoritative while failing in exactly the same way.

**The tier is chosen by what prerequisite the real dependency needs.** A real SDK exercised through its supported transport can be hermetic and belong in the unit tier. The integration ladder is for dependencies that need a service, a guest, or credentials; using a real dependency does not by itself justify a heavier tier.

**At a real dependency the observable sits on its far side — what the dependency DOES, not what your code hands it.** For event filtering, drive the SDK and observe what arrives at its transport; asserting the hook's return alone does not establish what the SDK sends. Exercise the dependency through its supported initialization path so the test observes the behavior production relies on.

**A fake is right for our OWN seams — and must be ANCHORED.** Pin the real shapes in the tier that can host them and keep the fake checked against that. An unanchored fake is a guess with a green tick.

**Captured fixtures are the fallback, not the goal** — a recorded payload goes stale silently while still passing, so capture only when nothing can host the real dependency at all. A committed recorder must be the fixture's only writer; its command, prerequisites, and contract must be discoverable. Nobody hand-edits the capture, and CI replays it without network access, so refreshing it means driving the real thing again. The recorder must own the preconditions its assertions depend on, or it silently encodes the recording machine. `.agents/skills/building-against-a-recorded-api/SKILL.md` is the standard for recording without drifting back into imagination.

**Non-deterministic real behaviour is recorded, not asserted.** A test that waits for a flake to fall the right way launders a coin flip into a claim. Document the observed limitation instead of adding a flaky assertion.

**Interactive terminal input is verified by hand, not automated.** Do not automate Clack's terminal renderer or add pseudo-terminal plumbing to a suite. Clack owns masking and cancellation; a suite drives the non-interactive `--stdin` path and a human checks the interactive one in a real terminal.

## Organizing integration tests

**Find the behavior's existing home before adding a test.** Search for the contract, related cases, and fixtures that already exercise it. Place the case where someone changing that behavior would expect to find it. The easiest insertion point is not necessarily the right boundary. If no existing suite fits, identify the responsibility that warrants a new one.

**Group cases around a coherent contract and compatible prerequisites.** Sharing a feature name alone does not justify putting model selection, cron execution, and database provisioning in one file. Let the behavior being proved and the environment needed to prove it determine the grouping.

**Give each case an explicit responsibility and assert it fully.** Include the relevant outcomes, side effects, and isolation guarantees. Do not repeat an upstream workflow's entire assertion set merely because it supplies a prerequisite. A consumer's own boundary still needs proof; similar subject matter alone does not make two cases redundant.

**Build on shared setup, not on earlier tests succeeding.** Each case establishes the mutable scenario state it needs. When the behavior is inherently ordered—create, migrate, update, verify preservation—keep that sequence in one lifecycle test, with assertions at each meaningful stage. Do not distribute one scenario across separate tests with hidden ordering dependencies.

**Observe asynchronous success and failure.** Wait for the promised outcome and surface terminal failures instead of polling until a timeout after the operation has already failed. Establish the inputs that can produce the expected state before waiting for it; no timeout can make a schedule appear before its declaration exists. Observe completion through the real contract, without adding a test-only production seam.

## Fixtures and resource ownership

**Tests acquire prerequisites through fixture dependencies.** Select only the capabilities the case needs. SQL-only tests must remain independent of web sessions, saved CLI logins and provider configuration. Fixtures supply prerequisites; [the operation under test stays in the body](#assert-on-the-contract-not-the-inside).

**Authentication setup must preserve the authority and protocol under test.** Exercise native session, viewer-handoff and OAuth flows when their behavior is part of the scenario. Web's isolated tests may use Better Auth's test utilities with the application's auth configuration when authentication is only a prerequisite. A fixture that acquires a native web session owns signing it out during cleanup. Follow [DevEnv initialization](ARCHITECTURE.md#development-environment) for the baseline user and organization.

**A coherent suite prepares its shared environment once.** Cases exercising the same contract should usually share a prepared environment through file-scoped fixtures or `beforeAll`. Share the prepared slate where compatible, while keeping mutable scenario state independent. Repeatedly creating equivalent environments or slates is a signal to reconsider the file's organization and setup lifetime. Exceptions must follow from the behavior being tested, such as proving initialization from empty state. One setup serving the file's cases is evidence of coherent organization, not a quota that justifies combining unrelated cases.

**Use the framework's lifecycle and the production path.** Exercise Workers through Wrangler's native test harness with the test configuration. Extend the shared [Worker fixtures](packages/platform/__tests__/workers.ts) so runtime lifetime and failure diagnostics have one owner. Let Wrangler own ports, readiness and runtime resources. Keep Workers that communicate through service bindings or cross-Worker Durable Object bindings in the same harness. Keep container cleanup in Miniflare, using consistent namespace identities for construction, introspection and forwarding; image labels, derived proxy images and ancestry sweeps must not become competing ownership mechanisms. [DevEnv](DEVELOPING.md#devenv) owns namespace persistence and cleanup behavior.

**A resource must outlive everything that uses it, including cleanup.** Scope scenario-owned remote cleanup inside the test body with `await using` and `AsyncDisposableStack`, so repositories and deployed Workers are reclaimed before the Worker fixtures needed for deletion close. Delete repositories through the configured `ARTIFACTS` binding that created them. Clean only the run's remote prefixes, including snapshot data and metadata; never a shared prefix. Fixture scope changes must preserve these dependency lifetimes.

When sharing a runtime, give its database, platform configuration, Worker configuration, and harness the same lifetime. Widening only one leaves its dependencies or cleanup with the wrong owner. Preserve scenarios that require empty state and case-specific failure diagnostics.

**Authored-slate scenarios use the real bundled starter.** Use `createSlateProject` from `@usecontextlayer/dev-env/slate` and add only scenario-specific source. A separately maintained fixture app can keep passing after the projects authors receive have broken. Keep the starter's configuration and installed build tools authoritative. Generate output inside the fixture-owned temporary project. The helper's installation option belongs to [its interface](packages/dev-env/slate.ts); select it when the scenario needs local installed dependencies.

**Exercise publication through the production transfer and publisher.** Keep deployment-configuration and temporary-credential contracts in Build's tests; do not inject test programs into an authored build to inspect trusted publication internals. Verify effective bindings on Cloudflare when changing publication: serialized upload metadata alone does not establish the deployed binding state.

## Maintain the testing model

**Test quality is ongoing maintenance, not a one-time cleanup.** When working in an area, review its existing tests against these principles. Do not copy a weak pattern merely because it already exists. If tests need restructuring or violate the guidance, explain the mismatch, propose a concrete improvement, and ask the user before expanding the work. Once approved, bring them into alignment while preserving coverage.

Tie this responsibility to the area being touched; do not turn every task into a repository-wide audit. Routine changes within an already-approved test refactor can proceed. Discovering a broader problem requires discussion, not an unsolicited rewrite.

## Running tests

Run from the repository root, using Turbo for package-scoped work:

```sh
pnpm test
pnpm run test:integration
pnpm exec turbo run test --filter=@usecontextlayer/shared...
pnpm exec turbo run test:integration:node --filter=@usecontextlayer/platform -- <file>.node.integration.test.ts
```

The root `test:integration` command requests all three integration tiers. Use `test:integration:node`, `test:integration:browser`, or `test:integration:claude` to select one tier; append `--testNamePattern '<case pattern>'` to a package invocation to select cases. Package scripts and Vitest configurations own the executable command/configuration details.

**Run one integration-suite invocation at a time. Finish builds before starting it:** fixtures read shared prebuilt output directories. Keep file parallelism enabled. If a failure suggests concurrency or parallelism flakiness, stop and discuss the affected test before changing it or retrying.

### Shared environment

Use [DevEnv setup](DEVELOPING.md#devenv) for service startup, baseline identity, the saved CLI login, Doppler configuration and Polar forwarding. The issuer, client and saved login must belong to that same DevEnv. Follow the root permission and machine-ownership rules when starting services or inspecting failures.

Run package test commands through their normal scripts. They own secret loading; do not add a second `doppler run` wrapper or a fixture-specific secret allowlist. Worker tests and deployment must use Wrangler's declared required secrets. Registry access is needed when generating/installing starter projects; Docker is needed when exercising containers. Those prerequisites do not belong on SQL-only or hermetic tests merely because they share a package.

**Isolated platform SQL does not isolate the DevEnv's web state or external services.** Tests may create sessions, OAuth registrations and grants in the shared web service. Ending a test session or dropping its platform database does not reclaim slate OAuth registrations. Tests that use the existing DevEnv platform/database must own their scenario rows and remote resources explicitly.

### Local Postgres

Use the server selected by `CTX_PLATFORM_DATABASE_URL`; [DevEnv](DEVELOPING.md#devenv) owns its configuration. If the shared Compose server is not running, start it once with `docker compose up -d postgres`. Do not stop, restart or reset it from a test session. Reclaim only databases your session created. An interrupted test can leave databases behind; a name prefix alone never proves a database is safe to delete. Report resources of uncertain ownership and ask before cleanup.

### Provider accounts and model credentials

Prepare connected accounts through the ordinary account API/CLI and its human browser authorization. Tests consume existing accounts; a test run is not permission to connect one or mutate a customer's mailbox. Provider verification uses read-only profile calls unless the user explicitly authorizes the exact customer writes.

Model cases require usable credentials under the Owner selected by the authored declaration. Follow [hosted model configuration](packages/platform/AGENTS.md#hosted-model-configuration) and [subscription access](packages/platform/AGENTS.md#hosted-subscription-access) to prepare those inputs. A service token is not a substitute for an Owner's provider credential. Case-specific requirements, such as distinct model selections or accounts, belong beside the case. Apply [the nondeterminism rule](#exercise-the-real-dependency): record model wording and tool ordering as observations rather than exact expectations.

### Secret-vault writes

Use the development Owner vault selected by Doppler `platform/dev`, following [Owner vault configuration](packages/platform/AGENTS.md#owner-vault-configuration). Do not substitute the production customer vault. Viewer-secret presence reads and value loads also require vault access.

**Live Doppler cases require authorization for each write, including cleanup.** Before running them, inspect the selected case and name its exact Owner, keys and resolved vault destination to the user. Approval for non-writing cases does not cover live writes. An interrupted run can leave secrets; inspect and agree further cleanup before writing again. Keep values, credentials and raw provider responses out of logs and failure diagnostics. Use `--testNamePattern non-writing` when only the non-writing cases are authorized; `--testNamePattern 'live Doppler'` selects the writing cases after authorization. CLI help owns input and Owner-selection syntax.

### Polar Sandbox

Use the complete Sandbox configuration and listener from [DevEnv](DEVELOPING.md#devenv). Keep Sandbox and production credentials and databases separate. Baseline Owners used for admitted execution need funded subscriptions. Prepare catalog-dependent scenarios against the matching Sandbox catalog; a passing declaration fetch alone does not establish runtime admission.

Polar Sandbox usage ingestion is authorized for tests and their reruns. **Exhaustion scenarios must own their customers and preserve baseline Owners' credits.** Immutable usage events remain as provider history even after customer cleanup. Allow for asynchronous webhook delivery and credit fulfillment; environment acquisition must not perform catalog discovery or consume Polar quota. Tests whose subject needs live catalog facts fetch them in their bodies.

### Cloudflare test resources

Use the native `test` environment and remote `contextlayer-test` Artifacts and dispatch namespaces, separate from production. Provision those reusable namespaces once in the configured Cloudflare account:

```sh
pnpm exec wrangler dispatch-namespace create contextlayer-test
npx cf artifacts namespaces create --namespace contextlayer-test
```

Use native Cloudflare authentication and select the intended account explicitly when needed. Retain the namespaces; each run owns only its repositories, Workers and object prefixes. Cloud-provider access is required even when the Worker runtime runs locally.

For remote build/publication verification, configure `CF_TOKEN` for test-namespace deployment and bucket-scoped Object Read & Write credentials `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` in Doppler `platform/dev`. Wrangler OAuth access to the test R2 bucket is separate from those transfer credentials. The [Build test configuration](packages/build/wrangler.jsonc) owns the bucket and binding names. Production credentials are not a substitute. R2-only credential verification needs neither Docker nor Postgres.

Native Workflows REST inspection requires the selected remote Workflow to exist. Local instances created by the Worker harness are not remote Cloudflare records.

## Recorded APIs

[Exercise the Real Dependency](#exercise-the-real-dependency) owns the recording policy. For Planner, the [write recorder](packages/mcp-microsoft-planner-premium/lib/cassette/record.ts) and [read recorder](packages/mcp-microsoft-planner-premium/lib/cassette/record-reads.ts) own their invocation, preconditions and captures. Their headers are the operating instructions. Do not make either recorder part of tests, builds or checks. Refreshing reads does not authorize running the customer-write recorder; the root [per-write permission rule](AGENTS.md#never-write-to-customer-data-without-per-write-permission) applies.

## Verifying unpublished CLI and SDK in a slate checkout

Production hosted slates must use published packages. Local development and integration tests may use unpublished CLI/SDK packages against the DevEnv, including source uploaded to an isolated `contextlayer-test` Artifacts repository.

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

This belongs only in the temporary unpublished-package setup; published matching versions resolve normally. Start the slate's dev server inside a `dev:env` subshell and run CLI commands against the checkout through `pnpm -C <path-to-this-checkout> dev:ctx …`, as under [Developing with a local slate](DEVELOPING.md#developing-with-a-local-slate). Use the generated checkout's own typecheck and build as part of the verification.

## Manual verification

### Local slate resources and agents

Use a slate checkout against the intended DevEnv and follow [unpublished package setup](#verifying-unpublished-cli-and-sdk-in-a-slate-checkout) when verifying branch changes. Verify local execution through an authored route using the saved developer account, and hosted execution through the pushed declaration and hosted assignment. Use read-only provider calls. Restart local development after declaration/configuration edits. CLI `--help` and the [SDK guide](packages/sdk/README.md) own operation syntax and migration authoring.

Direct POST requests to a React Router index action need the native `?index` query parameter that framework Form submissions supply. When changing local-resource integration, verify that the deployment build excludes the auxiliary Worker and local credentials.

Verify local agent instruction behavior with a real task. For hosted jobs, deploy instructions and declarations and prepare their selected Owner's credentials and resource assignments before execution. Run the upstream [computer conformance suite](packages/platform/__tests__/computer.node.integration.test.ts) before real-model acceptance so a broken execution environment is not mistaken for model behavior. Record model output under the nondeterminism rule; a successful greeting does not establish connected-tool or database behavior.

### Cross-site chrome and viewer sessions

Verify chrome through a hosted slate with pushed declarations and hosted assignments. **Use HTTPS on different sites for the slate and iframe, with third-party cookies permitted. Localhost ports alone do not reproduce hosted cookie delivery.** Secure cookies remain required during development; use a browser-supported secure localhost context or HTTPS rather than weakening cookie attributes.

Sign in through web, then load the slate without another sign-in interaction. Check profile and saved assignments, tray resize, authenticated reload and logout revocation. Verify that logout makes private slates require sign-in while public slates remain anonymously viewable. Confirm that the authored parent cannot read the iframe DOM and receives only presentation messages. Check that chrome permits framing only by its canonical target slate and dashboard pages deny framing. Check native same-origin form submission and rejection of credentialed cross-site submission. [The chrome contract](ARCHITECTURE.md#slate-chrome) owns the product semantics; browser policy can still prevent delivery even when server responses are correct.

For a manual dashboard sign-in redirect check, send `Accept: text/html`; curl's wildcard Accept header requests a different authentication response.

### Dashboard account switching

Use the baseline browser session from [DevEnv](DEVELOPING.md#devenv). Verify account switching changes the signed-in user and loads that user's Personal slate list; adding an account returns from web sign-in to the dashboard; signing out revokes the web session. Verify Owner navigation and refresh against the [dashboard Owner-selection contract](packages/platform/AGENTS.md#dashboard-owner-selection). Restore the baseline browser identity afterward so subsequent CLI approvals and tests use the intended account.

### Billing portal

Use an isolated Free Sandbox customer without payment details. With portal plan changes enabled, verify that the native portal can add a Sandbox payment method and upgrade. Preserve baseline customers and allow for asynchronous delivery before interpreting platform state.

### Planner onboarding

Before onboarding a user, verify deployed discovery documents and complete the real Composio connection flow, including Dataverse organization selection. Invoke `retrieve_records` for `msdyn_projects` and confirm the results belong to the selected organization. After token expiry, verify refresh and another successful read. Exercise operation-set submission/completion only with explicit permission for each exact customer write. **A successful build or connection screen does not establish this live verification.**
