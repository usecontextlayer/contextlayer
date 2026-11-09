# Testing

This document owns the repository's shared testing model: what a test proves, where it belongs, how it uses production code and real dependencies, and who owns its resources. Its purpose is conceptual integrity: new tests should reinforce the same model rather than introduce a competing one. Preserve the reasons and boundaries behind each rule when extending the suite.

[ARCHITECTURE.md](ARCHITECTURE.md) owns product contracts; [DEVELOPING.md](DEVELOPING.md) owns the DevEnv; [AGENTS.md](AGENTS.md) owns shared-machine and customer-data permissions. Test names and assertions own the executable coverage. Keep non-obvious scenario prerequisites and hazards beside the test or fixture they constrain; do not maintain prose copies of test bodies here. [Documentation guidance](AGENTS.md#documentation) defines documentation ownership.

For how Cloudflare recommends testing Workers — the Vitest integration, `createTestHarness()`, and Miniflare — see `~/ContextLayer/cloudflare-docs/src/content/docs/workers/testing/`, a shallow clone of [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs). Update it with `git -C ~/ContextLayer/cloudflare-docs pull --ff-only`.

## Testing principles

Review test changes with [tests-pin-behavior](.agents/checks/tests-pin-behavior.md), which judges what the assertions prove, and [tests-reuse-production](.agents/checks/tests-reuse-production.md), which judges how the test reaches production. The principles below explain the shared model; those checks apply it to changes. Neither check prescribes suite organization or demands additional coverage.

### Delegate Test Work

**Implementation agents delegate test creation and modification to a testing subagent with fresh context.** Separating test design from implementation gives the testing agent room to choose evidence from the intended outcomes, without inheriting the implementation agent's assumptions. The implementation agent stays focused on production code; the testing agent owns tests and test fixtures.

**Fresh context is mandatory.** Start the testing subagent without the parent conversation history. Supply the checkout, a closely related set of behavioral objectives, agreed constraints, unresolved requirements, and authoritative references. Describe what must be observable, leaving the testing agent to choose the cases, assertions, fixtures, tier, and files. Scope assignments by related objectives, not one subagent per test. The testing agent may inspect implementation and discuss it with the parent; independence does not mean withholding facts or user decisions.

Have the testing agent load [testing-as-a-subagent](.agents/skills/testing-as-a-subagent/SKILL.md), read this document and the testing checks, and review existing tests and production entry points before choosing whether to extend a case, add cases to an existing file, or create a file. Existing coverage may already establish an objective. The brief supplies outcomes, not a quota of new tests or a prescribed testing design.

**Use this collaboration at any point during implementation.** The same testing subagent can iterate with the implementation agent as the work develops, including during test-driven development when appropriate. It is an extra pair of hands focused on tests, not an end-of-implementation handoff or an approval gate. The implementation agent may revise direction or discard work; tests do not freeze the implementation. Keep the testing agent informed when objectives change, and preserve the user's authority over requirements and coverage tradeoffs.

**Production-code changes belong to the implementation agent.** When the testing agent cannot exercise an outcome through the available production boundary, it sends a problem statement: what it needs to do or observe, what it tried, and what prevents it. It does not prescribe a fix or edit production itself. The implementation agent owns the response and any production changes, including making and restoring the temporary regressions required by [Prove the Test Can Fail](#prove-the-test-can-fail). The testing agent specifies the behavioral regression to demonstrate and verifies the test's response. Coordinate edits, builds, and test runs under the [execution rules](#running-tests).

**The testing agent can require an answer from the human.** It may ask directly or require the implementation agent to relay the question. Once it reserves a question for the human, the implementation agent must ensure the question reaches the human and wait for their answer; it cannot answer on their behalf, silently settle the issue, or treat discarding work as resolving the question. Ordinary implementation facts and questions can be discussed between the agents. Return what the tests establish, verification evidence, and any unresolved questions or coverage limitations to the implementation agent, which remains responsible for the overall change.

### Test-First Is Opt-In

**Implement directly and cover with tests where the repo's conventions call for them; do not run the red→green ceremony by default.** Reach for test-first when the user asks for it on a task, or when a failing test is the cheapest proof that a subtle defect (a concurrency or ordering bug) is real. The ceremony costs real wall-clock on mechanical changes and earns its place only where the failing test is itself the evidence. A general standard that mandates test-first everywhere does not override this repo's stance.

### Prove the Test Can Fail

**Every new or changed test must be seen failing against a deliberate regression of the behavior it promises.** Once the test passes, break the production code under test the way a real regression would — drop the guard, invert the condition, return another Owner's row — and run the test. It must fail at the assertion that names the promise, for that reason. A failure anywhere else — a type or import error, a fixture that never comes up, a build that breaks — proves nothing about the assertion; make a narrower break. When an assertion constrains two sides, such as including one result and excluding another, break each side separately. Integration lanes load prebuilt test builds, so run the break through the lane's root command; a break the test build never received proves nothing.

**A test that still passes against the break guards nothing.** Strengthen it until the break fails it, or remove it. Never adjust the break until something fails: the break models the regression, and the test must answer to it.

**Restore the production code exactly, confirm an empty diff against the committed file, and run the test green again.** Never commit a break. Break code only in a checkout you own, where no other session's run or commit can pick it up.

This is the evidence test-first would have produced, gathered without its ceremony, so it applies whether or not the test was written first. Make each break by hand at the promised behavior: the question is whether this test guards this promise, not which code anywhere is unguarded.

### Placement & Tiers

Tests are sorted by a **filename suffix** defined in `vitest.shared.ts`. The **tier** separates unit tests (hermetic, run on CI) from integration tests (need real services, runtimes or remote resources, opt-in only). Unit tests are marked by **runtime**. **The unmarked name claims the default runtime: bare `*.test.ts(x)` runs in plain Node**, and `.browser.` marks browser-coupled tests. Integration tests are marked by **lane**: `<subject>.<lane>.integration.test.ts(x)`. Write a bare unit test unless it needs Chromium or an integration prerequisite.

**All tests should be behavioral; integration is a dependency requirement, not a separate standard of assertion.** Choose integration when the promise requires a real service or runtime boundary: Postgres constraints need Postgres, and Worker bindings need the native Worker runtime. Logic observable through a hermetic public contract stays in the unit tier.

**Put domain behavior matrices in unit tests and prove real connections through integration.** Owner and viewer selection, consumer projection, required-input refusals, and provisioning preparation are public domain contracts that can be tested directly with application-owned inputs. Integration proves configuration, transport, persistence, and real side effects that those units cannot establish. Do not repeat a domain matrix through Git pushes, builds, sandboxes, or model execution merely because those paths also consume it. Once a real operation has completed, retain related inexpensive assertions that establish its coherent lifecycle.

**An integration lane is one basket of capabilities.** Each lane runs as its own Vitest invocation, so its configuration can bound how many of its files run at once. That bound comes from the scarcest capability in its basket: the Docker VM's capacity for Build sandboxes, or a provider's rate limit. Every lane after basic includes the basic basket. Place a file in the lane whose basket covers what its cases need. When a file's cases need different baskets, split the file so each part lands in one lane, rather than carrying light cases into a constrained lane. A case that needs two constrained capabilities belongs in the lane with the tighter bound, whose basket then also carries the other capability.

**Remote Cloudflare resources have their own lane.** Use `remote` whenever a case or its fixture graph acquires remote Artifacts, dispatch namespaces, R2, or Cloudflare deployment resources. Local Worker execution does not remove those prerequisites. Mixed cases that also need sandboxes, Claude, or Polar belong in `remote`; its basket carries those capabilities. The remote concurrency bound must respect both the Docker VM's capacity for Build sandboxes and provider request budgets. Native local resources remain the choice where they exercise the production path. Secret-writing and signed-webhook scenarios retain their separately opt-in lanes and authorization requirements, including when they also need remote Cloudflare.

| Filename | Tier / lane | Turbo task | Per-package config | What belongs here |
| --- | --- | --- | --- | --- |
| `*.test.ts(x)` | Unit, Node | `test` | `vitest.config.ts` | Hermetic logic, local subprocesses/filesystem, and real Git fixtures over temporary directories |
| `*.browser.test.ts(x)` | Unit, Chromium | `test` | Browser project in `vitest.config.ts` | DOM rendering, browser globals, storage, and browser-only modules |
| `*.basic.integration.test.ts(x)` | Basic integration | `test:integration:basic` | `vitest.integration.basic.config.ts` | Local services, native local Worker bindings, real guests, and project generation without remote Cloudflare resources |
| `*.remote.integration.test.ts(x)` | Remote integration | `test:integration:remote` | `vitest.integration.remote.config.ts` | Remote Cloudflare resources, with Build/agent containers, real Claude, or Polar when the scenario also requires them |
| `*.polar.integration.test.ts(x)` | Polar integration | `test:integration:polar` | `vitest.integration.polar.config.ts` | Polar Sandbox calls and provider waits without remote Cloudflare prerequisites |
| `*.doppler-writes.integration.test.ts(x)` | Doppler writes, opt-in | `test:integration:doppler-writes` | `vitest.integration.doppler-writes.config.ts` | Writes to the development Owner vault, which need [authorization for each write](#secret-vault-writes) |
| `*.polar-webhooks.integration.test.ts(x)` | Polar webhooks, opt-in | `test:integration:polar-webhooks` | `vitest.integration.polar-webhooks.config.ts` | Signed Polar delivery through a [task-owned relay](#polar-sandbox) |
| `*.browser.integration.test.ts(x)` | Browser integration | `test:integration:browser` | `vitest.integration.browser.config.ts` | A real browser with a real local service behind it |

**CI runs only the unit tier**, including any browser unit projects. The integration lanes are opt-in/local-only; anything that must be covered in CI belongs in a unit test. Never move a test to a heavier tier for convenience and thereby give away its CI coverage.

A package carries a lane's config and script only when it uses that lane. Unit configs exclude the integration markers through `unitTestExclude`; only a package that actually runs browser tests may exclude that runtime's marker from its Node unit project. Misplaced tests therefore run in Node and fail instead of silently disappearing. A file in the wrong integration lane still runs, but under the other lane's bound, so review lane placement whenever a file's prerequisites change. When adding the first test of a lane, add the matching per-package config and task, composing the lane configuration exported by `vitest.shared.ts` with the package's own options.

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

**Every integration invocation prepares the complete test Worker set.** Integration tasks depend on the package-owned builds for Platform, Build, dispatcher and the standalone computer conformance Worker. Uniform prerequisites keep lane selection independent of compilation; Turbo deduplicates the builds across lanes and caches their outputs. Each harness loads those prepared outputs. Retain workspace dependency builds for imported package outputs. Unit `test` tasks depend only on those workspace dependency builds.

**Authentication setup must preserve the authority and protocol under test.** Exercise native session, viewer-handoff and OAuth flows when their behavior is part of the scenario. Web's isolated tests may use Better Auth's test utilities with the application's auth configuration when authentication is only a prerequisite. A fixture that acquires a native web session owns signing it out during cleanup. Follow [DevEnv initialization](ARCHITECTURE.md#development-environment) for the baseline user and organization.

**A coherent suite shares reusable prerequisites.** Cases exercising the same contract should usually share expensive prerequisites, such as a migrated SQL database, generated slate project, immutable platform configuration and Worker inputs, through file-scoped fixtures or `beforeAll`. These prerequisites outlive each case's Worker runtime and its cleanup. Share the prepared slate where compatible, while keeping mutable scenario state independent. Repeatedly preparing equivalent prerequisites or slates is a signal to reconsider the file's organization and setup lifetime. Exceptions must follow from the behavior being tested, such as proving initialization from empty state. One setup serving the file's cases is evidence of coherent organization, not a quota that justifies combining unrelated cases.

**Use the framework's lifecycle and the production path.** Exercise Workers through Wrangler's native test harness with the test configuration. Extend the shared [Worker fixtures](vitest.workers.ts) so runtime lifetime and failure diagnostics have one owner. Each independent case owns a fresh harness and closes it after its scenario cleanup and diagnostics. Creating a fresh server per case is [a supported Wrangler lifecycle](https://developers.cloudflare.com/workers/testing/test-harness/get-started/#manage-the-test-harness-lifecycle), and the harness runs the Workers' test builds through native bindings. Per-case ownership isolates local Worker state. Keep an ordered create/change/preserve lifecycle in one test body. Let Wrangler own ports, readiness and runtime resources. Keep Workers that communicate through service bindings or cross-Worker Durable Object bindings in the same harness. Keep container cleanup in Miniflare, using consistent namespace identities for construction, introspection and forwarding; image labels, derived proxy images and ancestry sweeps must not become competing ownership mechanisms. [DevEnv](DEVELOPING.md#devenv) owns namespace persistence and cleanup behavior.

Use native Workflow introspection to observe completion and failure. When the promise is Durable Object reconstruction from persisted storage, use native object eviction to exercise that boundary. A whole Worker reload is a different promise and needs an actual reload.

[Shared Vitest configuration](vitest.shared.ts) owns lane filename selection and shared native test options. Lane configurations are siblings: each selects its own files and concurrency bound, and none inherits another lane's configuration. Package configurations compose the lane with package-specific options where those policies apply. A lane's capability basket does not make it a configuration subtype of another lane. Timeouts, polling intervals and concurrency limits must be intentional and justified at the scope where they apply; moving configuration must preserve effective behavior rather than promote one package's settings into defaults for another. Each Worker's Wrangler configuration owns its container declarations; the harness uses Wrangler's native container behavior.

Shared provider constraints belong in native Vitest configuration and may be composed by sibling lanes. The Polar, remote and signed-webhook lanes compose the same Polar policy. Keep Polar's polling interval and worker bound together so assertions inherit the request-budget policy automatically. Deliberate per-assertion overrides remain appropriate when polling a different resource, such as saved webhook state in Postgres. Concurrency limits are per Vitest invocation; when lanes run together, their provider requests share the same account budget, so independent worker caps do not establish a combined rate limit.

**A resource must outlive everything that uses it, including cleanup.** Use `await using` and `AsyncDisposableStack` for scenario-owned remote cleanup, so repositories and deployed Workers are reclaimed before the Worker fixtures needed for deletion close. Keep resources created by the test body in that body's scope. Fixtures that acquire remote prerequisites use native Vitest fixtures with lexical disposal spanning setup and `use()`, so setup failures also release them. Delete repositories through the configured `ARTIFACTS` binding that created them. Clean only the run's remote prefixes, including snapshot data and metadata; never a shared prefix. Fixture scope changes must preserve these dependency lifetimes.

Closing a harness releases its local runtime resources; it does not erase Postgres rows or remote resources. Cases own their scenario records and observe their own state rather than relying on earlier cases or an empty shared database. Obtain bindings and the current origin from the case's active session. If a test explicitly resets the harness, reacquire them from the new session rather than retaining objects from its previous runtime. SQL-only cases must not acquire a harness just to participate in cleanup.

**Authored-slate scenarios use the real bundled starter.** The shared `build:test:slate-project` Turbo task calls `createSlateProject` from `@usecontextlayer/dev-env/slate` and caches the canonical empty, app, public, agents and MCP projects under `artifacts/slate-project/` for all integration lanes. Tests import `copySlateProject(checkout, options)` from that same module to copy the selected project into each scenario-owned mutable checkout and add only scenario-specific source. Its default is the complete app starter; select another scaffold when proving app-independent behavior. A separately maintained fixture app can keep passing after the projects authors receive have broken. Keep the starter's configuration and installed build tools authoritative. Generate scenario output inside its temporary checkout. Select the [copy helper's installation option](packages/dev-env/slate.ts) when the scenario needs local installed dependencies. Tests whose subject is slate-project generation call `createSlateProject` directly.

**Exercise publication through the production transfer and publisher.** Keep deployment-configuration and temporary-credential contracts in Build's tests; do not inject test programs into an authored build to inspect trusted publication internals. Verify effective bindings on Cloudflare when changing publication: serialized upload metadata alone does not establish the deployed binding state.

## Maintain the testing model

**Review duration alongside correctness.** For materially slow or timing-sensitive tests, measure fixture acquisition, scenario preparation, the operation and its asynchronous completion, and cleanup before choosing a fix. Compare focused and normal parallel-suite runs, recording cache state and host interruptions; overlapping spans are not additive. Remove repeated preparation and waits that do not serve the contract, while retaining real work required to prove it. Set a case's timeout from its complete measured lifecycle under the normal suite, with room for observed variation. A timeout is a failure bound, not a performance target; increasing it does not resolve unexplained duration. Keep detailed measurements and tradeoffs in the change's ExecPlan.

**Test quality is ongoing maintenance, not a one-time cleanup.** When working in an area, review its existing tests against these principles. Do not copy a weak pattern merely because it already exists. If tests need restructuring or violate the guidance, explain the mismatch, propose a concrete improvement, and ask the user before expanding the work. Once approved, bring them into alignment while preserving coverage.

Tie this responsibility to the area being touched; do not turn every task into a repository-wide audit. Routine changes within an already-approved test refactor can proceed. Discovering a broader problem requires discussion, not an unsolicited rewrite.

## Running tests

Run from the repository root, using Turbo for package-scoped work:

```sh
pnpm test
pnpm run test:integration
pnpm exec turbo run test --filter=@usecontextlayer/shared...
pnpm run test:integration:basic --filter=@usecontextlayer/platform -- <file>.basic.integration.test.ts
pnpm run test:integration:remote --filter=@usecontextlayer/platform -- <file>.remote.integration.test.ts
```

The root `test:integration` command runs the default lanes together: basic, remote, polar and browser. A failing lane must not cancel other started lanes before they report their results and finish harness teardown; cancellation can skip teardown and leave containers behind. The remote lane requires Cloudflare access and also carries the model, provider, and Docker prerequisites of its mixed scenarios. Use `test:integration:basic` for the local Cloudflare selection and `test:integration:remote` for the remote selection. The opt-in doppler-writes and polar-webhooks lanes run only through `test:integration:doppler-writes` and `test:integration:polar-webhooks`. Use `test:integration:<lane>` to select one lane; append a Turbo `--filter=` and then `-- --testNamePattern '<case pattern>'` to select a package and cases. Root scripts select tasks, Turbo owns shared build prerequisites, and package scripts select their Vitest configuration and required process-secret wrapper.

Every integration task waits for the packages' `build:test` tasks, Platform's `build:test:computer` task, and the shared root `build:test:slate-project` task. Turbo deduplicates slate-project generation across packages and lanes, and restores its output when the generator and its CLI/SDK build inputs are unchanged. To prepare only the generated slate project and its prerequisites, run `pnpm exec turbo run build:test:slate-project` from the repository root. Each Worker's test build writes its own output directory beside the ordinary build (`build-test/` for Platform, `dist-test/` for the others), and the [harness Worker inputs](vitest.workers.ts) load those test builds, never source or the ordinary builds. Platform's test build disables Node-compatible global timers, so its tests prove persisted-state recovery, not production's timer and idle-retention behavior. Root entrypoints and direct filtered Turbo runs receive the same prerequisites; invoking Vitest directly bypasses compilation and shared slate-project preparation.

**Run one integration-suite invocation at a time; the root command's lanes run alongside each other by design. Finish builds before starting it:** fixtures read shared generated output directories. Keep file parallelism enabled. If a failure suggests concurrency or parallelism flakiness, stop and discuss the affected test before changing it or retrying.

### Shared environment

Use [DevEnv setup](DEVELOPING.md#devenv) for service startup, baseline identity, the saved CLI login, Doppler configuration and Polar forwarding. The issuer, client and saved login must belong to that same DevEnv. Follow the root permission and machine-ownership rules when starting services or inspecting failures.

Run integration lanes through the root commands above so Turbo prepares their Worker test builds and generated slate project before the package runtime scripts execute. Calling a package's integration script directly bypasses these prerequisites and can use missing or stale test builds. Shared DevEnv configuration owns in-process provider settings; package scripts supply process secrets when the Worker graph or test requires them. SQL-only and self-contained local Worker tests need no secret loader. Do not add another `doppler run` wrapper or a fixture-specific secret allowlist. Worker tests and deployment must use Wrangler's declared required secrets. Registry access is needed when generating or installing slate projects; Docker is needed for configured container images during uncached test builds and whenever a harness loads a Worker configuration that declares containers. SQL-only cases must remain independent of service or provider credentials, and hermetic unit tests must not acquire integration prerequisites merely because they share a package.

**An isolated platform database does not isolate the web database selected by its DevEnv or external services.** Cases using the same web issuer may create sessions, OAuth registrations and grants in that database. Ending a test session or dropping its platform database does not reclaim slate OAuth registrations. Tests that use the existing DevEnv platform/database must own their scenario rows and remote resources explicitly.

### Local Postgres

Use the server selected by `CTX_PLATFORM_DATABASE_URL`; [DevEnv](DEVELOPING.md#devenv) owns its configuration. If the shared Compose server is not running, start it once with `docker compose up -d postgres`. Do not stop, restart or reset it from a test session. Reclaim only databases your session created. An interrupted test can leave databases behind; a name prefix alone never proves a database is safe to delete. Report resources of uncertain ownership and ask before cleanup.

### Provider accounts and model credentials

Prepare connected accounts through the ordinary account API/CLI and its human browser authorization. Tests consume existing accounts; a test run is not permission to connect one or mutate a customer's mailbox. Provider verification uses read-only profile calls unless the user explicitly authorizes the exact customer writes.

Model cases require usable credentials under the Owner selected by the authored declaration. Follow [hosted model configuration](packages/platform/AGENTS.md#hosted-model-configuration) and [subscription access](packages/platform/AGENTS.md#hosted-subscription-access) to prepare those inputs. A service token is not a substitute for an Owner's provider credential. Case-specific requirements, such as distinct model selections or accounts, belong beside the case. Apply [the nondeterminism rule](#exercise-the-real-dependency): record model wording and tool ordering as observations rather than exact expectations.

### Secret-vault writes

Use the development Owner vault selected by Doppler `platform/dev`, following [Owner vault configuration](packages/platform/AGENTS.md#owner-vault-configuration). Do not substitute the production customer vault. Viewer-secret presence reads and value loads also require vault access.

**Live Doppler cases require authorization for each write, including cleanup.** They run only in the opt-in doppler-writes lane, never in the default suite. Before running them, inspect the selected case and name its exact Owner, keys and resolved vault destination to the user. Approval for non-writing cases does not cover live writes. An interrupted run can leave secrets; inspect and agree further cleanup before writing again. Keep values, credentials and raw provider responses out of logs and failure diagnostics. Non-writing secret cases remain in the default suite and use the remote lane when their fixture graph acquires remote Cloudflare resources. CLI help owns input and Owner-selection syntax.

### Polar Sandbox

Use the shared Sandbox baseline and complete configuration from [DevEnv](DEVELOPING.md#devenv). Keep Sandbox and production credentials and databases separate. Ordinary execution uses the shared personal and organization Owners’ Unlimited entitlements. Subscription and balance scenarios must own isolated customers and exercise the real public catalog’s Free and paid subscriptions, or deliberately leave customers unsubscribed. Never exhaust shared Owners to establish a scenario. A passing declaration fetch alone does not establish runtime admission.

Normal `pnpm dev` and default integration selections require no listener. For real signed enrollment and state-change verification, start one task-owned DevEnv with `pnpm dev --polar-listen`, wait for Polar's `Connected` message, then run `pnpm test:integration:polar-webhooks`. Establish forwarding before creating scenario customers so their enrollment events reach this DevEnv; service readiness and relay connection are separate prerequisites. Stop the task-owned relay and restart plain `pnpm dev` before default-suite verification, because organization-wide forwarding can enroll Free concurrently with scenario-owned setup. Never stop another session’s listener without permission. Record this uncached selection separately from the default suite, whose success does not establish signed delivery.

Polar Sandbox usage ingestion is authorized for tests and their reruns. Immutable usage events remain as provider history even after customer cleanup. Allow for asynchronous webhook delivery and credit fulfillment; environment acquisition must not perform catalog discovery or consume Polar quota. Tests whose subject needs live catalog facts fetch them in their bodies.

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

Verify hosted agent instruction behavior with a real task through the native Pi runtime. Deploy instructions and declarations and prepare their selected Owner's credentials and resource assignments before execution through the hosted API. Local agent execution is deferred; the app development server is not an agent runner. Run the upstream [computer conformance suite](packages/platform/__tests__/computer.basic.integration.test.ts) before real-model acceptance so a broken execution environment is not mistaken for model behavior. Record model output under the nondeterminism rule; a successful greeting does not establish connected-tool or database behavior.

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
