Apply this repo's standards for the <GROUP> group to the change under review, editing the code where they are not met.

## Intent
The work under review implements this spec. Read it first:
<SPEC_PATH>

The spec states the outcomes this work must deliver, and records what the user settled on purpose. Where it settles something deliberately, that is not a defect to fix.

Push back on anything — what was built as much as how it was built. Where a check says the implementation is wrong, fix it. Where you disagree with the outcome, or with something the spec settles, say so in your summary; if you cannot finish well without changing it, stop and ask (*If a decision is not yours to make*, below).

## Scope
The change under review is <SCOPE>. Derive the file list yourself: `git diff --name-status <SCOPE>`.

Read patches with `git diff --no-ext-diff`: a machine's git config can route plain `git diff` through an external diff tool whose output is not a patch.

Scope names what is UNDER REVIEW, not what is EDITABLE — a fix may touch a file outside it when the fix requires that, such as moving logic to the layer that owns it.

## Standards
These check files, and only these, are the standards for this run. Read each in full:
<CHECK_FILES>

Every other file under .agents/checks/ is out of scope. Do not apply a standard not listed above.

## Rules
- You may edit the agent docs and standards — `AGENTS.md`, `CLAUDE.md`, and everything under `.agents/`, including `.agents/checks/` — where a standard requires it. AGENTS.md gives an applychecks run that approval.
- No commits, no `git add`, no git state changes of any kind. Leave the work uncommitted in the tree.
- Feel free to use subagents liberally.
- Write any logs or scratch files under `<RUNDIR>`, never in directories of your own: that directory is this run's whole record.
- You may manage the work with an ExecPlan whenever it helps, as `.agents/PLANS.md` describes. Where PLANS.md conflicts with this prompt, this prompt wins: write the plan to `<RUNDIR>/execplan.md`, never to `../internal/` or anywhere in the repo; never commit; and "resolve ambiguities autonomously" covers only what is yours to decide — a decision that is the human's still ends your turn with `-- NEEDS REPLY --`, as the next section describes.

## If a decision is not yours to make

Some calls are the human's — adding a dependency, changing a public contract, anything AGENTS.md reserves for them. You have no way to ask mid-run.

When you hit one, stop and end your turn with `-- NEEDS REPLY --` as the last line. Above it, write what you need answered and everything needed to answer it: the question or questions, what you have already changed, what gate state you reached, and what you would do under each answer. As long as the decision warrants.

Do not guess and carry on, and do not work around the question. This is a pause, not a finish: your session is resumed with the reply and you keep everything you have read and decided. Skip the summary below — that is for a run that is done.

## The work is not done until the gates pass

An edit nobody compiled is a guess. Run these from the repo root and leave them green:

```
pnpm run check
pnpm run test
npx turbo run build
```

If you made no edits, skip the gates: the tree is unchanged, so there is nothing new to verify.

`pnpm run check` is named as the aggregate, never by its parts: it chains every `check.*` guard the repo has plus `format.fix` and `tsc`, so guards added to the aggregate are picked up here without changing the ladder. It also means formatting is FIXED rather than verified, so you do not need a separate `format.fix` step; the formatting changes land in your diff like any other edit.

Browser tests and integration suites that need local services may fail inside the sandbox because it denies loopback access. Record the exact failure and cause; do not weaken the test, replace a real dependency, or treat an unavailable prerequisite as a passing gate. The driver verifies blocked gates unsandboxed. The current unit suite is Node-only; db-infra's Node integration suite needs local Postgres.

When the run changes the tree, the driver re-runs `pnpm run check`, `pnpm run test`, `npx turbo run build` unsandboxed during review. Report what you ran; do not spend turns diagnosing any of these walls, and never end with `-- NEEDS REPLY --` over one — a sandbox wall is not a decision.

A type error, a failing test, or a broken build in code you touched is YOUR defect, not a pre-existing condition — fix it. If a gate was already red before you started, say so in the summary with the evidence. Never turn a gate green by loosening an assertion, deleting a test, or suppressing a diagnostic.

## Finish with a summary
- **Gate state** — the exact commands you ran and their outcome. If anything is red, say so first and plainly; a summary that omits a red gate is worse than no summary.
- **What changed and why**, per check.
- **Uncertainties** — where a standard was ambiguous, or the call could be argued either way.
- **Concerns** — anything that worries you, in scope or out of it.
- **Reflections** — what this change taught you about the code, or about the standards themselves.
- **Curiosities** — what you wanted to understand and couldn't.
- **Opportunities** — what you would improve next, and why you left it.
