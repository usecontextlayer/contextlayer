---
name: conceptual-rebase-review
description: Use when rebasing or merging a branch onto a base that gained commits (the upstream base moved, e.g. origin/main), when a rebase or merge applied cleanly and you're tempted to trust it, or when resuming a branch or spec written before the base moved.
---

# Conceptual Rebase Review

**A conflict-free rebase proves nothing.** Git checks that text merges; it cannot check that the *concepts* your work is built on still hold. This review — not the mechanical `git rebase` — is the actual work of landing on a moved base. For every commit the base gained, answer one question:

> **Had I started from this base, would I have implemented the spec differently?**

("The spec" = whatever defines the branch's intent — a spec doc, a ticket, or what the branch set out to do.) If yes for any commit, the branch is conceptually stale no matter how cleanly it rebases.

Throughout, `<base>` is the ref you are rebasing or merging onto — `origin/main` in the usual case.

## When to use

- Before rebasing or merging onto a moved base — and before trusting a rebase or merge that already applied cleanly.
- `git fetch --prune` first, then `git rev-list --left-right --count <base>...HEAD`. A stale remote-tracking ref hides exactly the commits this review exists to catch.
- Skip only when the base gained nothing.

## What to look for

Read `git log --oneline HEAD..<base>` and interrogate each commit:

- **Moved sources of truth** — a registry, schema, generator output, or config that your work registered itself in may be mid-relocation to a new home. Check who *generates* the thing and who *consumes* it on the base today, not just where copies sit.
- **New or changed conventions** — doctrine docs, renamed packages, changed layering, new shared helpers that your code should now be using.
- **Generated-file ownership** — a file added raw on the base (unformatted, or produced by no committed generator) is a drift trap; note it.

**Example.** A conflict-free rebase hid that origin/main had grown a *second* copy of the plugin registry in a new package — another workstream's mid-flight relocation. The text merged cleanly; the concept had moved. Harmless only after verifying nothing consumed the new copy yet.

## Method: git archaeology

Use **Opus subagents** ("think carefully", read-only git) to reconstruct the other workstream's intent — or do the archaeology yourself if you can't fan out:

- What workstream produced the new code, and what do its branches plan? (`git for-each-ref --sort=-committerdate refs/remotes`, `git grep <symbol> origin/<branch> -- <paths>`)
- Does anything on the base consume the new thing yet?

**Verify every load-bearing subagent claim yourself** before acting on it — subagent output is a claim, not a finding.

## Verdict

- **Concepts hold** → proceed with the rebase or merge. A conflict during it → stop and discuss with the user; never resolve it silently — a textual collision here is often a concept that moved.
- **Concepts moved** → stop and discuss with the user before touching anything. Whether the moved concepts change what the work should do is the user's call, not yours.
