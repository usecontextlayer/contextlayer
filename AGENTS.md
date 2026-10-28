# AGENTS

Start here. This file is the agent's working contract: how to understand this codebase, preserve its conceptual integrity, build and operate it, and maintain its documentation. Root rules apply across the repository; read the applicable package or subtree `AGENTS.md` before changing that area. The [documentation map](#documentation) tells you where to read and where to write.

## Never Write to Customer Data Without Per-Write Permission

**THIS OUTRANKS EVERYTHING BELOW IT.**

A write to a customer's system is irreversible, carries their name, and may land in front of *their* client. **Permission to test, smoke, verify, or debug is NEVER permission to write.** Ask before each write — naming exactly what and exactly where — and wait for the answer.

This rule triggers on what you are about to **do**, never on your judgment about whether the data looks important. That judgment is precisely what fails mid-task, when the write is just the next step in a plan you already believe is authorized. Stop and ask when any of these is true — no assessment required:

- A tool named `create_*`, `update_*`, `delete_*`, or `send_*` is about to reach a customer's system.
- You are about to answer **Yes** to a permission prompt — claude's in-terminal ask in the console.
- The session is impersonating a customer user.

**A permission prompt is not a safety mechanism when you are the one driving.** It exists so a human bounds an agent holding a token that can write anything in that org — for a delegated write, that prompt is the entire constraint. If you generate the call AND you answer Yes, you hold both roles and nothing is bounding anything; the prompt renders, gets approved, and looks exactly like the mechanism working. On any write to customer data, the human answers the prompt. Never you.

Customer data means anything that is theirs: records in their Planner, Dataverse, mail, or calendar; content in their systems; their chats. Operating their deployment — deploying, restarting, reading — is ordinary sanctioned work and is not covered here. If you are unsure whether something is theirs, it is.

## Production Is Never a Development Target

The production platform, the production web issuer, and the saved login in `~/.contextlayer` are the user's own production account. The built CLI defaults to all three, so running it outside the DevEnv acts as the user in production. Development work runs against the DevEnv in [DEVELOPING.md](DEVELOPING.md#devenv). Before any command that reaches a platform, know which platform URL and which login it will use; a production answer is a stop that needs the user's explicit direction for that specific action.

## The Machine Is Shared: Own Only What You Created

This machine hosts long-lived shared state and OTHER concurrent sessions: the docker-compose Postgres instance, other agents' checkouts, ephemeral test databases, and background processes. **Your session owns exactly what it created — its databases and processes — and nothing else.**

- Never stop, restart, or "fix" the docker-compose Postgres instance from a session — it is machine-global. If it is down, `docker compose up -d postgres` (starting it once) is the only sanctioned intervention; never `restart` or `down`.
- Kill only by exact PID of a process you spawned. Pattern kills (`pkill -f`) can match other sessions' processes; a matching name does not establish ownership.
- Leaked-looking databases, listening ports, processes, or runtime directories are never cleaned unilaterally. Report what you found and ask whether to clean up, then verify nothing live still holds them before acting.
- Resetting your environment means stopping only the processes and reclaiming only the databases your session created — never machine-wide cleanup.

## Documentation

**Each document has one job. Read the owner before working in its domain; put new information with that owner.** This map is both the reading path and the writing standard.

- **[ARCHITECTURE.md](ARCHITECTURE.md) — understand the system before designing a change.** Owns domain concepts and terminology, package ownership, dataflow, stable relationships, trust boundaries, security guidance, principles, and architectural invariants. Explain why the boundaries matter and state what the system **must uphold**; today's implementation is not the definition of correctness. This document carries the system's conceptual integrity. Its [domain model](ARCHITECTURE.md#domain-model) owns the slate vocabulary; other documents use and link that vocabulary rather than redefining it.
- **AGENTS.md — decide how to work and construct changes.** Owns agent orientation, permissions, construction principles, pattern discipline, and documentation standards. Root guidance preserves consistent patterns and intended layering across the repository. Subtree guidance adds the rules specific to its area. Testing-specific construction rules belong in TESTING.md.
- **[DEVELOPING.md](DEVELOPING.md) — set up, build, run, debug, migrate, release, or operate the system.** Owns commands, prerequisites, local development, migrations, and operational workflows, including the constraints needed to execute them. Read it before running or debugging the DevEnv.
- **[TESTING.md](TESTING.md) — write, organize, run, or debug tests and perform manual verification.** Read it before doing any of those. Owns the coherent testing model: principles and their rationale, tiers, fixture/resource ownership, shared prerequisites, execution, and manual verification. Test names and assertions own coverage; non-obvious scenario constraints belong beside their test or fixture. Do not duplicate test bodies or implementation walkthroughs in documentation.
- **ExecPlans — implement and track a specific change.** Own implementation decisions, slice progress, verification evidence, temporary limitations, and remaining work. Keep detailed implementation and session history here.
- **[.font-awesome.md](.font-awesome.md) — use the shared icon system.** Owns the Font Awesome kit, default family/style, and import conventions for all packages. Read it before adding or changing icons.

Package-specific guidance belongs in that package's `AGENTS.md`, except testing guidance, which belongs in `TESTING.md`. A package usually needs only an `AGENTS.md`; split out its own `ARCHITECTURE.md` and `DEVELOPING.md` only when that file grows too large. The root architecture and development documents own repo-wide guidance.

`docs/` owns user-facing explanations, tutorials, and API reference. Package READMEs introduce the package, provide a quickstart, and link to detailed guidance. Generated checkout READMEs retain the instructions needed to run and deploy that checkout. Normative architecture and contributor rules remain with their existing owners.

### Preserve Meaning at Its Owner

**Use [comments-say-what-code-cant](.agents/checks/comments-say-what-code-cant.md) and [choosing-the-idiomatic-shape](../.agents/skills/choosing-the-idiomatic-shape/SKILL.md) when writing, reviewing, or reorganizing documentation.** Apply the check's discipline of reader, ownership, durable rationale, and preservation across the whole corpus. Apply the skill to document structure: find the existing owner and use its concepts before inventing another document, vocabulary, or source of truth. Construction rules still belong in documentation even when current code follows them: they constrain the next change.

**`cutting-to-the-base-case` NEVER APPLIES TO DOCUMENTATION**, including specs, plans, and documentation reviews. Do not discard established concepts, rationale, constraints, exceptions, or deliberately unsupported paths because they fall outside the current implementation slice or describe an uncommon case. Documentation preserves the model future changes must honor.

**One argument, one home. Preserve the reason; do not copy the ruling around the tree.** A ruling written twice gets corrected once and rots everywhere else. Other documents state the instruction their reader needs and link to the owner for the contract and rationale. A link must tell the reader when to follow it; a directory of unexplained links is not guidance.

Keep durable concepts, principles, contracts, and development requirements in lasting documentation. Exact UI copy, icon colors, component wiring, and callback mechanics belong in code; implementation history and per-slice status belong in the relevant ExecPlan. Promote a decision when it establishes a durable invariant or development requirement. Do not turn a feature's implementation narrative into permanent architecture.

Write for the reader who must act here. Preserve non-obvious WHY, boundary semantics, deliberate refusals, and consequences of violating a rule. Replace incident memoirs with the present constraint they justify. Before removing or relocating an explanation, read its other homes and establish where its reasoning will survive. **Judge content by its purpose and owner. Never reward terseness at the expense of meaning.**

### Prefer Discoverable Documentation

When a tool can answer a question, put the answer in the tool, not in companion documentation (skills, READMEs, reference markdown).

- For CLI commands: the `.description()` on each command, option, and argument is the canonical place for usage, shape, defaults, and one-line semantics. Use the tool's `--help`. Anything duplicated outside of `--help` is waste that drifts.
- Companion docs (skill files, operating references) carry ONLY what the tool cannot: sequencing rules, the *why* behind each step, file-system artifacts, cross-command workflows, and gotchas discovered from experience.

When you notice a skill/doc line that could live in `--help`, the fix is to improve the `--help` text — not leave it duplicated in the doc.

## How to Think and Work

### Preserve Conceptual Integrity

**Pattern quality is a first-order concern. The codebase must remain one coherent system that a human can understand and change.** The same concept must retain its meaning, vocabulary, and ownership wherever it appears. A new consumer must not invent another interpretation of an existing concept. ARCHITECTURE.md owns the model; construction must preserve it.

This applies **throughout the system**: architecture and layering, data models and dataflow, APIs and errors, configuration, framework integration, tests and fixtures, module organization, runtime behavior, and documentation. It is the default discipline for every change, not a narrow coding guideline.

**Find the owner before choosing the implementation.** Look first at the framework you are inside, then installed libraries, established codebase patterns, and platform or language standards. Use the owner's concepts, vocabulary, contracts, and lifecycle as-is. Before writing a custom utility, check the standard library and installed dependencies. Prefer popular, well-maintained, battle-tested libraries for common concerns such as parsing, serialization, quoting, validation, and process execution.

**Extend what exists: one way, not two.** Reuse established patterns whenever they fit. Keep one owner per concern and one source for each decision; do not add a parallel implementation and then machinery to keep the copies consistent.

**Existing code is evidence, not permission to perpetuate the wrong shape.** Picture the intended system without today's accidents. Do not force a pattern into a problem it does not fit, or copy a local pattern that contradicts the architectural model. Surface the mismatch and show the human the owner and how its pieces fit together. The human decides the shape; an agent does not silently revise a standing decision.

**Reduce scope by building less of the intended shape, never by building a worse shape.** Preserve room for the next step through the boundaries you choose; do not implement that step before it is needed.

- If no existing pattern fits and a new one appears necessary, **STOP and ask before implementing it.** No new pattern without explicit user sign-off.
- If fit is unclear or debatable, treat it as **does not fit yet** and ask before introducing variation.
- **New dependencies require approval before adding them.** Do not install new packages by default.

Conceptual integrity informs both the architecture and the way we change it: [Conceptual Integrity](https://wiki.c2.com/?ConceptualIntegrity) and [Architect as Keeper of the Flame](https://wiki.c2.com/?ArchitectAsKeeperOfTheFlame).

### Clarify Early

Ask clarifying questions when requirements are ambiguous or there are multiple plausible interpretations. Confirm scope and intent before implementing; do not continue too far on assumptions.

### Escalate Permissions Early

When a required action is blocked by sandbox or permission limits, escalate and request approval. Do not spend time on hacky workarounds when escalation is the correct path.

## Operating the Repo

**Use pnpm, supplied by mise.** Corepack stays unused. Use `pnpm`, `pnpm exec`, and `pnpm install --frozen-lockfile`; never `npm install`, `npm ci`, or `yarn`. Internal dependencies use `workspace:*`; commit dependency changes in `pnpm-lock.yaml`. [Setup](DEVELOPING.md#setup) owns tool installation and version configuration.

**Package-scoped tasks ALWAYS run through Turbo with `--filter=` selectors**, for example `pnpm exec turbo run <task> --filter=@usecontextlayer/<pkg>...`. Do not use npm `--workspace` targeting. [Workspace commands](DEVELOPING.md#workspace-commands) owns the task workflows.

**Doppler must resolve to workplace ContextLayer.** Run `doppler me` before use; stop and tell the user if it shows another workplace. Reads are fine; creating or changing projects, configs, or secrets is user-territory. [Doppler guidance](DEVELOPING.md#doppler) owns configuration and operating instructions.

## Code Standards

### Design for Multiple Consumers

**Almost every capability exposed through the platform web UI must have an OpenAPI operation that also powers the CLI and can later power MCP. Design product operations for multiple consumers from the start.** Follow [the multiple-consumer architecture](ARCHITECTURE.md#multiple-consumers) and [platform's construction rules](packages/platform/AGENTS.md#openapi-zod-and-shared-domain-functions); do not build a UI-only business-logic path.

### Unidirectional Dataflow and Layering

**Make dataflow, dependency direction, and control transfer explicit.** Parse, validate, and normalize at boundaries; pass typed values into shared operations and serialize results at the output boundary.

- CLI/API/job adapters call shared domain operations. Domain operations must not depend on transport adapters or their request/context objects.
- Keep calculations deterministic over explicit inputs and outputs. Isolate I/O from those calculations; a shared operation that authorizes and performs a database write is not a pure calculation.
- Prefer direct calls and return values over hidden callbacks, cross-layer mutation, or circular orchestration. Use framework-owned lifecycle hooks where the framework owns control.
- Keep retries, branching, and fan-out in the operation's coordinator, with deterministic calculations beneath it. Do not create another architectural layer merely to make an I/O-owning operation appear pure.

### Errors Must Be Loud

Do NOT silently catch and drop errors (validation, coercion, parsing, runtime, or integration failures).

- Never use an empty `catch {}` or log-and-continue when correctness is affected.
- Treat validation/coercion failures as correctness signals, not optional branches.
- Either throw the error, preserving its cause when adding context, or return an explicit structured failure that callers must handle.
- Never advance cursors/checkpoints/ack state based on records that failed validation, parsing, or persistence.

#### Handle Real Failures, Not Hypotheticals

- First run the real workflow, capture actual exceptions, and let failures teach us what needs handling.
- Add handling only for observed failures with concrete evidence (triggering input/payload and traceback).
- Keep handlers narrow and explicit (specific exception types/conditions), and preserve loud failure for unknown cases.
- If in doubt, do not add a catch; let the error surface and then fix the real contract gap.

### Environment Variables

For all TypeScript packages in this repo, read environment variables through a package-local `env.ts` module rather than direct `process.env` access in feature modules.

If the package does not already have an `env.ts`, create one first and route env access through it.

- Add typed/sanitized fields to the `env` schema for known variables.
- For dynamic env var names, use values exported from `env.ts` (not direct `process.env` reads in feature modules).
- Keep normalization, defaults/fallbacks, and hard-fail/required-variable checks in the package's `env.ts`. This applies to shared/runtime libraries too; no other module may supply its own defaults.
- DevEnv command and test settings must use the shared composition of startup's connection facts; pass server and credential-directory settings explicitly to in-process auth and subprocess consumers. Follow the [DevEnv architecture](ARCHITECTURE.md#development-environment), [OAuth resource contract](ARCHITECTURE.md#oauth-resources-and-scopes), and [startup workflow](DEVELOPING.md#devenv).

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

- If an alias does not exist for a needed path, add/update alias configuration first instead of using a relative import.
- The CLI’s React Router app template maps `@/` to the slate root. Preserve the framework-generated `./+types/...` imports as the exception to the alias rule.
- This rule does NOT apply to one-off scripts outside `./packages`.

### CLI Input Parsing

When a CLI command gives semantic meaning to an option or argument, validate/coerce it with Zod instead of ad hoc parsing logic.

- If a command is just transporting argv to another tool, keep it opaque.
- Define parsing/coercion rules in one place per input (for example, port bounds, integer requirements, trimming/normalization).
- Use schema validation errors to gate invalid CLI input before command execution.

### Passthrough Subprocesses

For true CLI passthrough commands, prefer transparent child-process behavior over wrapper logic.

- Use `execa` with inherited stdio: `stdio: "inherit"`.
- Use `reject: false` and propagate child exit codes directly via `process.exitCode`.
- Do not buffer/replay child stdout/stderr in passthrough handlers.
- Only use piped stdio when the caller must parse or transform child output.

## Completing a Change

### Keep the Agent Docs Current

**Review affected documentation as part of every change, using the [ownership map](#documentation).** This includes affected root and subtree `AGENTS.md`/`CLAUDE.md` files, documents they explicitly reference, and the checks under `.agents/checks/`.

- Correct an affected concept, principle, contract, or development workflow in the document that owns it. A feature change does not require an entry in every document. **A stale line in an always-loaded doc actively misleads every future session.**
- Beyond your change's scope, propose concrete improvements with the exact edit when guidance is wrong, drifted, or incomplete. Do not silently rewrite standards.
- Checks retain their stricter approval rule below; finding an error does not authorize changing the standard.

### Apply the Checks Before Committing to Main

**Any change bigger than a couple of lines gets the checks applied before it is committed to main.** The checks in `.agents/checks/` are this repo's judgment-call standards — the defects that survive tsc, biome, and the test suite. The `applychecks` skill runs one named group of them through codex, which edits the tree directly; read [.agents/skills/applychecks/SKILL.md](.agents/skills/applychecks/SKILL.md), relative to this repo root, before the first run of a session.

**Checks are living standards — propose improvements, never edit them unilaterally.** While working on a feature, if a check cries wolf, misses something it should have caught, or a new standard emerges, say so and propose the exact edit. Adding, editing, or removing anything under `.agents/checks/` requires explicit user approval first — the same rule as introducing a new pattern. An applychecks run carries that approval for codex; its edits to checks still wait for the user before they are committed.
