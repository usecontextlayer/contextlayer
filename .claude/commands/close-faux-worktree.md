---
description: Land a finished faux-worktree branch — commit, conceptually rebase onto origin/main, run the CI-equivalent gates, ff-merge to main, archive the spec, and tear the checkout down with close-faux-worktree
argument-hint: "[faux-worktree-dir]  (default: cwd if it matches the <repo>-<branch> convention)"
---

Land work done in a **faux worktree** — a sibling checkout made by `setup-faux-worktree` (its own `.git`, a local clone; `git worktree` commands do NOT apply). The teardown counterpart is `close-faux-worktree` (both in `~/.local/bin`; read them if unsure — close verifies clean tree + merged-into-default, deletes the origin branch, prunes the source checkout, and `rm -rf`s the folder).

Every step below gates the next. Stop and discuss with the user whenever a step says so — landing is not a race.

## Step 1 — Resolve and settle the worktree

Args: `$ARGUMENTS` — the faux worktree dir, or infer from cwd (folder name `<repo>-<branch>`, e.g. `contextlayer-2026-07-03-foo` → branch `2026-07-03-foo`).

- `git status` — if anything is uncommitted, **stage it yourself** (`git add`; gitcp never stages) and commit+push with `source ~/.zshrc && gitcp`. If the `claude` call inside gitcp is credit-blocked, retry with `LLM_STAGED_MSG_CLAUDE_CMD=claude-alnu-ca` (or `-com`).
- Confirm the branch is pushed: `git rev-parse origin/<branch>` matches HEAD.

## Step 2 — Fetch and locate yourself

    git fetch --prune origin
    git rev-list --left-right --count origin/main...HEAD

Show both sides: `git log --oneline origin/main..HEAD` (yours) and `git log --oneline HEAD..origin/main` (what main gained). If main gained nothing, skip to Step 4.

## Step 3 — Conceptual rebase review (the real work)

Apply the **conceptual-rebase-review** skill (`.agents/skills/conceptual-rebase-review/SKILL.md`) to the commits main gained in Step 2. Its verdict gates this step:

- Concepts hold → `git rebase origin/main`. A conflict → stop, discuss with the user; never resolve it silently.
- Concepts moved → **stop and discuss with the user** before touching anything.

## Step 4 — CI-equivalent gates (see `.github/workflows/check.yml`)

Run in the faux worktree, in this order:

    find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete   # stale tsc -b cache false-passes otherwise
    pnpm install --frozen-lockfile                                       # also proves no lockfile drift
    node --import tsx scripts/release.ts verify                           # the release-version consistency gate CI runs
    pnpm run check                                                       # every check.* guard the repo has — named as the aggregate on purpose, see below
    npx turbo run tsc test format.verify tsc.scripts --concurrency=4     # the Node CI lane, one invocation — the flag is part of it, see below
    pnpm run build                                                       # the workspace artifact build CI runs
    pnpm run test:integration                                            # all local-only tiers — CI runs none of them, so landing is where they must
    git status --porcelain                                               # must be empty afterward

The browser and Claude test obligations remain when their suites return. Do not silently drop `test:integration` or treat missing prerequisites as a passing gate.

- **`pnpm run check` is named as the aggregate rather than by its parts, and that is the point.** It chains every `check.*` guard the repo has, so a guard added later is picked up here for free. Naming them individually is what goes stale: this ladder listed only `check.workspace-references` for the whole life of `check.tailwind-deprecations`, and nothing said so — a landing ladder that quietly stops being CI-equivalent is worse than one that never claimed to be. Two consequences worth knowing rather than rediscovering: its `tsc` is redundant with the turbo lane below and turbo serves it from cache, so it costs nothing; and its `format.fix` **mutates** where CI's `format.verify` only checks, so a formatting failure lands as a dirty tree at the final gate instead of a red lane. Read that gate's output as a real finding.
- Account for every failure AND every skip — "pre-existing" is not an excuse. A failure inherited from main (e.g. a generated file landed unformatted) is a real finding: surface it to the user with a minimal proposed fix to carry on this branch; do not land a main you know is red.
- Interleaved turbo logs hide failure detail — re-run the single failing task alone to read it.
- **`--concurrency=4` is part of the lane, not a tuning knob** — `check.yml` passes it explicitly (down from turbo's stock 10) and this step is only CI-equivalent with it. Omitting it on a many-core machine invents failures that are not in the code: tasks die with a bare `ELIFECYCLE` and no diagnostic, and every one of them passes when re-run alone (2026-08-22: `slate:tsc`, `slate:test`, and `engine:test` all failed at stock concurrency and all passed in isolation, leaving one genuine failure). Suspect thrash whenever a task fails with no error text — but confirm by re-running it alone rather than assuming, since a real failure can look the same in the interleaved log.
- **`npx <tool>` failing with a doubled `node_modules/node_modules/…` path is environment state, not code — and the `pnpm install --frozen-lockfile` above is a known trigger.** Some pnpm installs leave a member-local `node_modules/.bin` shim for a root-hoisted tool (tsc, tsx, vite…) with no matching member-local package dir; npm's `npx` then resolves that shim against `<repo>/node_modules` instead of `<repo>` and execs a path that does not exist. Two tells: the whole lane dies in seconds behind many identical `ELIFECYCLE Command failed` lines with nothing actually compiled, and `pnpm exec <tool> --version` succeeds where `npx <tool> --version` crashes — the shims themselves are correct, only npm's resolution is not. **A `node_modules` wipe plus clean install does NOT reliably heal it**: the reinstall regenerates the same ghosts (2026-08-15, `base-schemas` came back with ten where a healthy sibling worktree had one). Heal by deleting the ghost shims themselves — every `.bin` entry whose owning package has no dir in that member's `node_modules`, reading the owner off the shim's exec line rather than its filename (`tsc`/`tsserver` are owned by `typescript`). Check a sibling clone first: this is worktree-scoped, so a second checkout resolving `npx` fine means the repo and npm are innocent. Then re-run the lane with `--force` — a cached turbo run replays logs without ever invoking the shim, so a green board proves nothing until the cache is busted.
- After any rebase or fix commit: `git push --force-with-lease origin <branch>` so origin's branch matches what will merge.

## Step 5 — ff-merge to main and push

    git checkout -B main origin/main
    git merge --ff-only <branch>
    git push origin main

If `--ff-only` refuses, main moved during the gates — go back to Step 2. Never create a merge commit here.

- Pushing main starts neither `check.yml` nor `release.yml`; both workflows require explicit dispatch. If this change alters a contract shared with a deployed consumer, coordinate the releases so production does not run incompatible versions. Use `node --import tsx scripts/release.ts --help` for the retained release ladder; do not assume a merge alone completes a deployment.

## Step 6 — Update and archive the spec

The feature's spec lives in `~/ContextLayer/internal/in-progress/`. Update its **Status** to shipped (merge hash, date, one-paragraph verification summary), then `mv` it to `~/ContextLayer/internal/archived/`. Fix inbound links to it from `internal/in-progress/` and `internal/planned/` only — archived docs are tombstones, never edited. No git commands against `~/ContextLayer/internal`.

## Step 7 — Tear down the faux worktree

From **outside** the folder (it refuses to run from within, and your shell would dangle):

    cd ~/ContextLayer && close-faux-worktree <faux-worktree-dir>

Then verify the remote branch is gone: `git -C ~/ContextLayer/contextlayer ls-remote --heads origin <branch>` prints nothing. Also stop/remove any session infrastructure the work stood up (background daemons, throwaway databases, docker containers) — but leave standing conventions (e.g. the test-harness Postgres container) alone.

## Step 8 — Confirm, then sync the main checkout

Report the landing to the user (merge hash, gate results, anything flagged in Step 3/4) and **ask before this final step**. On confirmation, in `~/ContextLayer/contextlayer`: verify it is on `main` with a clean tree (if not, report and ask instead of proceeding), then `git pull` — it should be a pure fast-forward of exactly the commits you merged.
