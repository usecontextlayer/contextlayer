# AGENTS

This pnpm workspace retains three private packages: db-infra, shared, and twilio. The old product stack and deployment images have been removed. Both GitHub workflows are manual-only.

## Never Write to Customer Data Without Per-Write Permission

**THIS OUTRANKS EVERYTHING BELOW IT.**

A write to a customer's system is irreversible, carries their name, and may land in front of *their* client. **Permission to test, smoke, verify, or debug is NEVER permission to write.** Ask before each write — naming exactly what and exactly where — and wait for the answer.

This rule triggers on what you are about to **do**, never on your judgment about whether the data looks important. That judgment is precisely what fails mid-task, when the write is just the next step in a plan you already believe is authorized. Stop and ask when any of these is true — no assessment required:

- A tool named `create_*`, `update_*`, `delete_*`, or `send_*` is about to reach a customer's system.
- You are about to answer **Yes** to a permission prompt — claude's in-terminal ask in the console.
- The session is impersonating a customer user.

**A permission prompt is not a safety mechanism when you are the one driving.** It exists so a human bounds an agent holding a token that can write anything in that org — for a delegated write, that prompt is the entire constraint. If you generate the call AND you answer Yes, you hold both roles and nothing is bounding anything; the prompt renders, gets approved, and looks exactly like the mechanism working. On any write to customer data, the human answers the prompt. Never you.

Customer data means anything that is theirs: records in their Planner, Dataverse, mail, or calendar; their workspace content; their chats. Operating their deployment — deploying, restarting, reading — is ordinary sanctioned work and is not covered here. If you are unsure whether something is theirs, it is.

**Read the companion documents when their domain comes up:**

- **`ARCHITECTURE.md`** — the package overview.
- **`DEVELOPING.md`** — setup, workspace commands, test prerequisites, and operational conventions. Read it before running or debugging the local environment.
- **`node --import tsx scripts/release.ts --help`** — the version helpers and automatic commit/push/check/tag/release ladder. Both workflows require explicit dispatch.

## How to Work

### Pattern Discipline

**THIS IS SUPER IMPORTANT!**

**Pattern quality is a first-order concern in this codebase. Human maintainability depends on consistent, intentional patterns. Conceptual integriy and clarity of domain concepts is of very high importance**

Agents *MUST* strongly prefer existing patterns whenever they fit. *Treat this as a default behavior for implementation work, not a narrow coding guideline.*

#### When to apply

**ALL THE TIME**

This applies across the full system, including:

- Architecture and layering (boundaries, responsibilities, composition, dependency direction)
- Dataflow and data modeling (schemas, transformations, invariants, serialization boundaries)
- APIs and interfaces (function signatures, error shapes, contracts, naming conventions)
- Configuration and environment handling (env loading, defaults, validation, normalization)
- Library and framework usage (existing abstractions, idioms, integration style)
- Testing strategy and test shape (fixtures, helpers, assertions, structure, naming)
- File and module organization (placement, ownership boundaries, export patterns)
- Operational/runtime conventions (logging, subprocess handling, retries, failure behavior)
- Writing style and documentation patterns (tone, structure, examples, rationale format)

#### Rules

- Reuse established patterns when they fit.
- Do NOT force an existing pattern into a problem it does not fit.
- If no existing pattern fits and a new pattern appears necessary, STOP and ask the user for approval before implementing it.
- If fit is unclear or debatable, treat it as "does not fit yet" and ask the user before introducing variation.
- Do NOT introduce a new pattern without explicit user sign-off.

These rule exists to keep the codebase understandable and maintainable for humans.

### Clarify Early

Ask clarifying questions when requirements are ambiguous or there are multiple plausible interpretations.

Do not continue too far on assumptions. Confirm scope and intent first, then implement.

### Escalate Permissions Early

When a required action is blocked by sandbox or permission limits, escalate and request approval.

Do not spend time on hacky workarounds for permission issues when escalation is the correct path.

### The Machine Is Shared: Own Only What You Created

This machine hosts long-lived shared state and OTHER concurrent sessions: the docker-compose Postgres instance, other agents' checkouts, ephemeral test databases, and background processes. **Your session owns exactly what it created — its databases and processes — and nothing else.**

- Never stop, restart, or "fix" the docker-compose Postgres instance from a session — it is machine-global. If it is down, `docker compose up -d postgres` (starting it once) is the only sanctioned intervention; never `restart` or `down`.
- Kill only by exact PID of a process you spawned. Pattern kills (`pkill -f`) have taken down other sessions' processes — an observed incident, not a hypothetical.
- Leaked-looking databases, listening ports, processes, or runtime directories are never cleaned unilaterally. Report what you found and ask whether to clean up, then verify nothing live still holds them before acting.
- Resetting your environment means stopping only the processes and reclaiming only the databases your session created — never machine-wide cleanup.

### Apply the Checks Before Committing to Main

**Any change bigger than a couple of lines gets the checks applied before it is committed to main.** The checks in `.agents/checks/` are this repo's judgment-call standards — the defects that survive tsc, biome, and the test suite. The `applychecks` skill runs one named group of them through codex, which edits the tree directly; read [.agents/skills/applychecks/SKILL.md](.agents/skills/applychecks/SKILL.md), relative to this repo root, before the first run of a session.

**Checks are living standards — propose improvements, never edit them unilaterally.** While working on a feature, if a check cries wolf, misses something it should have caught, or a new standard emerges, say so and propose the exact edit. Adding, editing, or removing anything under `.agents/checks/` requires explicit user approval first — the same rule as introducing a new pattern. An applychecks run carries that approval for codex; its edits to checks still wait for the user before they are committed.

### Prefer Discoverable Documentation

When a tool can answer a question, put the answer in the tool, not in companion documentation (skills, READMEs, reference markdown).

- For CLI commands: the `.description()` on each command, option, and argument is the canonical place for usage, shape, defaults, and one-line semantics. Use the tool's `--help`. Anything duplicated outside of `--help` is waste that drifts.
- Companion docs (skill files, operating references) carry ONLY what the tool cannot: sequencing rules, the *why* behind each step, file-system artifacts, cross-command workflows, and gotchas discovered from experience.
- For every reference or skill doc line, the check is: "If this sentence could live in `--help`, why isn't it?"

When you notice a skill/doc line that could live in `--help`, the fix is to improve the `--help` text — not leave it duplicated in the doc.

### Keep the Agent Docs Current

**The agent-facing doc set is part of every change's definition of done.** That set: every `AGENTS.md`/`CLAUDE.md` (root and subtree), every document they explicitly reference (`ARCHITECTURE.md`, `DEVELOPING.md`, …), and the checks under `.agents/checks/`.

- If your change makes any statement in these docs false or incomplete — a moved file, a renamed flag, a retired workflow, a new prerequisite — updating the doc is PART of the change, not a follow-up. A stale line in an always-loaded doc actively misleads every future session.
- Beyond your own change's blast radius: when you notice a line that is wrong, drifted, or missing something these files should carry, suggest the improvement to the user — concrete, with the exact edit. Do not silently rewrite standards.
- `.agents/checks/*.md` keep their stricter rule: propose the exact edit and wait for explicit user approval (see "Apply the Checks Before Committing to Main").

## Operating the Repo

### Package Manager: pnpm

> **Package manager: this workspace uses pnpm** — pinned via the `packageManager` field in the root `package.json` and provided by mise (`mise.toml` pins the same version; mise is the one pnpm source, corepack stays unused). Use `pnpm` / `pnpm exec` / `pnpm install --frozen-lockfile`; never `npm install`, `npm ci`, or `yarn`. Internal deps use the `workspace:*` protocol; the committed lockfile is `pnpm-lock.yaml`. Workspace tasks run through Turbo (see "Workspace Command Targeting" below).

### Workspace Command Targeting

For package-scoped tasks in this repo, ALWAYS use Turbo with `--filter=` selectors.

- Preferred: `npx turbo run <task> --filter=@usecontextlayer/<pkg>...`
- Do NOT use npm `--workspace` targeting for these runs.

### Local Development

Run setup and workspace commands from `DEVELOPING.md`. Libraries expose `dev:watch` for rebuilds; there is no app server or dev-composition launcher in this workspace. The shared local Postgres instance is needed only for database integration tests.

### Doppler

Env vars for deployed surfaces live in Doppler, workplace **ContextLayer** — run `doppler me` before use and stop and tell the user if it shows any other workplace. Reads are fine; creating or changing projects, configs, or secrets is user-territory. Read `DEVELOPING.md` to learn more.

## Code Standards

### Libraries First

Prefer existing libraries over writing custom code. The best code is code we did not have to write.

When multiple options exist, prefer popular, well-maintained, battle-tested libraries over custom helpers for common concerns (for example parsing, serialization, quoting, validation, and process execution).

Before implementing a custom utility or abstraction, check whether the behavior already exists in:

- The language standard library
- Dependencies already installed in this repo

If a new dependency is needed, ask for approval first before adding it. Do not install new packages by default.

### Unidirectional Dataflow and Layering

Design features so both data flow and control flow are explicit and one-way.

- Structure flows as: `input -> validation/normalization -> core/domain logic -> side effects/integrations -> output`.
- Keep dependency direction single-way: outer layers (CLI/API/jobs) can call inner core modules; core modules must not import boundary/infrastructure modules.
- Perform parsing/coercion/serialization at boundaries; pass typed, normalized values into core logic.
- Domain logic should try to be a functional core: deterministic functions over explicit inputs/outputs, with side effects pushed to edges.
- Keep control transfer explicit. Prefer direct function calls and return values over hidden callbacks, cross-layer mutation, or circular orchestration.
- If orchestration requires retries/branching/fan-out, keep that in one coordinator layer and keep core logic deterministic.

### Errors Must Be Loud

Do NOT silently catch and drop errors (validation, coercion, parsing, runtime, or integration failures).

- Never use an empty `catch {}` or log-and-continue when correctness is affected.
- Treat validation/coercion failures as correctness signals, not optional branches.
- Either throw the error, preserving its cause when adding context, or return an explicit structured failure that callers must handle.
- Never advance cursors/checkpoints/ack state based on records that failed validation, parsing, or persistence.

#### Handle Real Failures, Not Hypotheticals

- Do NOT add speculative error-handling for failures we have not observed in real usage.
- First run the real workflow, capture actual exceptions, and let failures teach us what needs handling.
- Add handling only for observed failures with concrete evidence (triggering input/payload and traceback).
- Keep handlers narrow and explicit (specific exception types/conditions), and preserve loud failure for unknown cases.
- If in doubt, do not add a catch; let the error surface and then fix the real contract gap.

### Environment Variables

For all TypeScript projects/packages in this repo, read environment variables through a package-local `env.ts` module rather than direct `process.env` access in feature modules.

If the package does not already have an `env.ts`, create one first and route env access through it.

- Add typed/sanitized fields to the `env` schema for known variables.
- For dynamic env var names, use values exported from `env.ts` (not direct `process.env` reads in feature modules).
- Keep all normalization and defaults centralized in `env.ts`.
- Keep hard-fail/required-variable checks centralized in `env.ts`.
- Do not implement env defaults/fallbacks in non-`env.ts` modules (including shared/runtime libraries).

#### Environment Variable Naming

An env var's **prefix declares its scope** — whose configuration it is. This keeps ownership obvious and stops two subsystems from naming the same thing differently.

- **`CTX_`** — a shared ContextLayer resource or setting. Use it consistently wherever that resource is read.
- **The reader never sets the scope — the owner does.** A value forwarded into another subsystem keeps its owner's prefix; a cross-process reader never promotes it.
- **One resource → one var.** Two subsystems must not name the same thing differently.
- **Consistent suffixes.** Database connection strings use `_DATABASE_URL`, never `_DSN`.
- **Runtime env and build arguments are distinct.** Do not treat a Docker build argument as deployment runtime configuration.
- **Third-party vars keep their upstream names** (`CLAUDE_*`, `SENTRY_*`, `TWILIO_*`, `NODE_ENV`). Data-model column prefixes and code constants are not env vars.

### TypeScript Imports

For TypeScript packages in `./packages`, ALWAYS use `@` aliases for internal imports.

- Do NOT use relative path imports like `../` or `../../` for internal modules.
- Use the configured alias path instead (for example, `@/auth/session`).
- If an alias does not exist for a needed path, add/update alias configuration first instead of using a relative import.
- This rule does NOT apply to one-off scripts outside `./packages`.

### CLI Input Parsing

For CLI option/argument parsing and coercion, use Zod schemas instead of ad hoc parsing logic.

- If a command gives semantic meaning to an input, validate/coerce it with Zod.
- If a command is just transporting argv to another tool, keep it opaque.
- Define parsing/coercion rules in one place per input (for example, port bounds, integer requirements, trimming/normalization).
- Use schema validation errors to gate invalid CLI input before command execution.

### Passthrough Subprocesses

For true CLI passthrough commands, prefer transparent child-process behavior over wrapper logic.

- Use `execa` with inherited stdio: `stdio: "inherit"`.
- Use `reject: false` and propagate child exit codes directly via `process.exitCode`.
- Do not buffer/replay child stdout/stderr in passthrough handlers.
- Only use piped stdio when the caller must parse or transform child output.

### Testing

#### Test-First Is Opt-In

**Implement directly and cover with tests where the repo's conventions call for them; do not run the red→green ceremony by default.** Bugs still get a regression test — that is a coverage rule, not an ordering one. Reach for test-first when the user asks for it on a task, or when a failing test is the cheapest proof that a subtle defect (a concurrency or ordering bug) is real. The ceremony costs real wall-clock on mechanical changes and earns its place only where the failing test is itself the evidence. A general standard that mandates test-first everywhere does not override this repo's stance.

#### Placement & Tiers

Tests are sorted by a **filename suffix** along two orthogonal axes defined in `vitest.shared.ts`: the **runtime** (plain Node or Chromium) and the **tier** (unit = hermetic, runs on CI; integration = needs a real local prerequisite, opt-in only). **The unmarked name claims the default runtime: bare `*.test.ts(x)` runs in plain Node.** `.browser.` marks browser-coupled tests. Write a bare unit test unless it needs one of those runtimes or an integration prerequisite.

| Filename | Runtime / tier | Turbo task | Per-package config | What belongs here |
| --- | --- | --- | --- | --- |
| `*.test.ts(x)` | Unit, Node | `test` | `vitest.config.ts` | Hermetic logic, local subprocesses/filesystem, and real Git fixtures over temporary directories |
| `*.browser.test.ts(x)` | Unit, Chromium | `test` | Browser project in `vitest.config.ts` | DOM rendering, browser globals, storage, and browser-only modules |
| `*.node.integration.test.ts(x)` | Node integration | `test:integration:node` | `vitest.integration.node.config.ts` | A real local service such as Postgres, or a real guest |
| `*.browser.integration.test.ts(x)` | Browser integration | `test:integration:browser` | `vitest.integration.browser.config.ts` | A real browser with a real local service behind it |
| `*.claude.integration.test.ts(x)` | Claude integration | `test:integration:claude` | `vitest.integration.claude.config.ts` | Real Claude with its required credentials |

**CI runs only the unit tier**, including any browser unit projects. The three integration tiers are opt-in/local-only; anything that must be covered in CI belongs in a unit test. Never move a test to a heavier tier for convenience and thereby give away its CI coverage.

A package carries a tier's config and script only when it uses that tier. Unit configs exclude the integration markers through `unitTestExclude`; only a package that actually runs browser tests may exclude that runtime's marker from its Node unit project. Misplaced tests therefore run in Node and fail instead of silently disappearing. When adding the first test of a tier, add the matching per-package config and task using the includes exported by `vitest.shared.ts`.

`DEVELOPING.md` owns the run commands and prerequisites. The remaining suite has Node unit tests in shared and Node integration tests in db-infra. Browser and Claude tasks and taxonomy are retained.

#### Assert on the Contract, Not the Inside

**A test earns its place by being invariant to the inside and sensitive to the promise: refactor the implementation freely and the test does not move; change what the unit promises and it breaks.** Both halves are load-bearing — a test that survives every refactor because it asserts nothing has the property vacuously and guards nothing.

**The discipline that produces it: drive and observe a unit only through its public contract, never through its inside.** The inside is the implementation — internal helpers, private intermediate state, the sequence of calls a function makes on its way to an answer, the shape of a structure that never leaves. A test that reads any of those is a second copy of the implementation, and a copy has the inverse of a test's value: it cannot fail when the promise changes (its only job), and it always fails when the code is reshaped (never its job).

**This is what makes reshaping affordable.** Making a hard change easy before making it assumes the reshape is cheap, and it is only cheap while the suite does not move with it — a suite that mirrors implementation makes refactoring MORE expensive than having no suite at all, because you pay to rewrite assertions that were never testing anything real, and the bill lands on every later change rather than on the one that added them.

**You pick the unit; the rule is only that you do not reach inside the one you picked.** "Contract" is not a synonym for "end-to-end" — a single-function test is fully in-contract when it drives that function's arguments and asserts its return. This rule never argues for a bigger test or a heavier tier; `Placement & Tiers` decides that.

**Production code never grows a seam for a test.** A `*ForTest` export, a test-only branch, or a cross-layer hook that exists so a test can see inside is the white-box defect billed to the shipping artifact. A unit that cannot be exercised through its contract is too coupled — inject the dependency at an idiomatic boundary, or the unit is the wrong size. Fix the design; never widen the visibility.

**A test double neither satisfies nor violates this rule.** It is in-contract when it stands at a boundary and the assertion reads the far side; out-of-contract when the assertion reads the double's own call log, which is our code's inside seen through a stand-in. Whether a double belongs there at all is `Exercise the Real Dependency`.

#### Exercise the Real Dependency

**Where a dependency is real, the test drives the real thing.** A hand-authored payload — an SDK event, an API response, a stream ordering — is an assertion about somebody else's contract, written from memory: it cannot fail when that contract changes, which was its only job. It looks like coverage and is the opposite. Completeness does not rescue it: a payload hand-authored from the docs with every field filled in is the same frozen guess wearing more detail, and it reads as more authoritative while failing in exactly the same way.

**The tier is chosen by what prerequisite the real dependency needs — and most need nothing.** Well-built SDKs hand you the seam (`@sentry/*` takes a `transport`): driving those is hermetic, belongs in the unit tier, and runs on CI. The integration ladder is for dependencies that genuinely need a service, a guest, or credentials.

**At a real dependency the observable sits on its far side — what the dependency DOES, not what your code hands it.** A `beforeSend` hook's contract is which events the SDK sends: drive the client, capture at the transport, count what arrived. Know which integrations your test client has by reading the SDK — a hand-built `@sentry/node` `NodeClient` gets NO defaults (`Sentry.init` assembles them, the constructor does not).

**A fake is right for our OWN seams — and must be ANCHORED.** Pin the real shapes in the tier that can host them and keep the fake checked against that. An unanchored fake is a guess with a green tick.

**Captured fixtures are the fallback, not the goal** — a recorded payload goes stale silently while still passing, so capture only when nothing can host the real dependency at all. A committed recorder must be the fixture's only writer; its command, prerequisites, and contract must be discoverable. Nobody hand-edits the capture, and CI replays it without network access, so refreshing it means driving the real thing again. The recorder must own the preconditions its assertions depend on, or it silently encodes the recording machine. `.agents/skills/building-against-a-recorded-api/SKILL.md` is the standard for recording without drifting back into imagination.

**Non-deterministic real behaviour is recorded, not asserted.** A test that waits for a flake to fall the right way launders a coin flip into a claim. Document the observed limitation instead of adding a flaky assertion.
