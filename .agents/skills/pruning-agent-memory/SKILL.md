---
name: pruning-agent-memory
description: Use when an agent-memory corpus needs pruning, auditing, or cleaning — memory has grown bloated, drifted from the project's rule docs, or filled with stale task state — and when deciding whether a given fact belongs in memory at all rather than in a spec, a doc, or a code comment.
---

# Pruning Agent Memory

Memory is auto-loaded into **every** session and is unversioned. Docs and specs are read on demand and are git-backed. That asymmetry decides everything here: a line in memory charges rent in every future session forever, and nothing but another agent's judgment ever corrects it.

## What a memory is

**A memory is something you LEARNED. Anything you COPIED belongs where you copied it from.**

That is the whole idea, and it is sharper than "is this still relevant." Ask where the content came from:

- **Copied** from a spec, doc, ticket, code comment, or commit → it is a **cache with no invalidation**. It will drift, and the moment it drifts it starts contradicting the source it was summarizing. Point at the source instead.
- **Learned** by running into it — a trap, a mechanism that surprised you, a ruling the user made in conversation → there is **no upstream to drift from**, because it was never written down anywhere else. This is what memory is for.

This is why empirically-learned traps are memory even though they feel incidental, and why a beautifully-written summary of a live spec is not.

A memory that hedges about its own accuracy has already failed. When you find `"don't work from this memory's detail — the spec wins"` or `"READ THE SPEC FIRST"`, you are looking at a cache that knows it is stale. Delete the body; keep at most the pointer.

## The governing test

Apply to **every paragraph**, never to a whole file. The two kinds interleave inside a single memory, so file-level verdicts either destroy learnings or preserve changelogs.

1. Is it still true and useful **after this task ships and its spec is archived**?
2. Does it bind work **beyond the task that produced it**?

Two yeses → keep. Otherwise it is task state — status lines, decision ledgers, per-slice progress, which-commit-shipped-what, resume points, "still owed" lists, dated build narration — and it belongs in the project's planning docs.

**One carve-out: a pointer may stay when it disambiguates.** Which doc is authoritative, that it moved to `archived/`, that it supersedes three others. One line. Never the content behind it.

### The discriminations that are actually hard

Both columns below routinely appear **in the same sentence** — that is why the test is per-paragraph:

| keep — a mechanism, learned | cut — an instance or a status |
|---|---|
| "Kysely's Migrator existence-check introspects EVERY schema, so it races a concurrent `DROP SCHEMA`" | "`gc-scheduler-server.test.ts` must call `applyMigrations`" |
| "an unmatched `pnpm --filter` exits 0 and silently skips the step; `turbo --filter` exits 1" | "the version split left 8 packages behind" |
| "seeding calendar fixtures through Graph sends REAL invitations to every attendee" | "the calendar round's spec is complete, implementation paused" |
| "`az vm update` sends a full-body PUT and fails with a misleading zone-movement error" | "the VM is a `D2ads_v6`" |

The right-hand column is not worthless — it is just addressed to a different reader. Site-specific instances belong in a tripwire comment at the edit site, where the future editor is the actor. Asset facts and project status belong in the planning docs.

**Correct the frontmatter `description` too.** It is loaded every session and will outlive a fixed body — a stale description is the failure mode that survives your rewrite.

## The three stages

Non-negotiable in structure; free in mechanism. Use subagents when the corpus is large enough that one context cannot hold it, passes when it is not.

**1. Audit** — classify every paragraph against the rule corpus and the governing test.

**2. Adversarial verify** — a second, independent pass whose only job is to **refute** the destructive verdicts, defaulting to REFUTED under uncertainty. This is the stage that earns its cost: in the run this skill came from, it killed **46%** of proposed deletions and **11 of 13** whole-file deletions. Verify from the bytes, not the auditor's quotes.

**3. Damage check** — after execution, confirm nothing ruled KEEP was destroyed. If the user ordered specific content deleted, **preserving it here is a failure, not a save** — say so explicitly in the checker's brief, or it will "helpfully" restore what the user just told you to drop.

## The evidence bar

A memory only **conflicts** with a rule when you can produce all three: **the rule file, the rule's verbatim quote, and the memory's verbatim quote**. Anything less is staleness or falsity — real findings, but different ones, and they must not be filed as conflicts. Without this bar, agents inflate every stale line into a rule violation and the report becomes unusable.

## Traps specific to this job

- **Not every rule doc is a rule.** Assemble the corpus deliberately and check each member is live. A dead or superseded conventions file will condemn *correct* memories — in the source run, an abandoned repo's `AGENTS.md` mandating a since-removed toolchain would have deleted two accurate entries.
- **Inspection standards are not authoring rules.** A check written for a code reviewer ("infer from the change under review…", with `## Do NOT flag` exemptions) does not govern how memory is written. Roughly half the filed conflicts collapsed on this distinction alone.
- **Repo-scoped rules do not travel.** A standalone repo's conventions file binds that repo, not its neighbours.
- **"It's already covered elsewhere" is the most dangerous sentence in the audit.** It was frequently false: the claimed destination — a doc, a code comment, another memory — was **empty**. Open the destination and confirm the content is actually there before deleting on that ground.
- **Deleting a file is a multi-file edit.** Sweep the whole corpus for inbound `[[wikilinks]]` and index entries first, and fix them in the same pass.

## The asymmetry, and who decides

A wrong deletion is unrecoverable. A wrongly-kept paragraph costs tokens. When genuinely torn, keep it and flag it — but do not use this as cover for hoarding, or the corpus never shrinks.

**Findings go to the user, not straight to execution.** Present them grouped, with your read and a recommendation; deletions that would destroy the only surviving copy of something get named as such, explicitly, before they happen. The user's ruling then **overrides every agent in the pipeline** — including a verifier arguing eloquently to preserve something. "Delete it; we'll add it back if we need it" is a legitimate answer to "this is the only copy," and it is not yours to overturn.

## Order of operations

Establish ground truth yourself → assemble and sanity-check the rule corpus → shard → audit → adversarially verify → **stop and get rulings** → execute the rewrites → damage-check → rebuild the index and sweep links **last**.

Ground truth first, because the fleet will otherwise re-derive load-bearing facts independently and some will be wrong; verify the handful of empirical claims the whole audit rests on yourself, and hand them down. Index last, because until it is rebuilt it keeps advertising content the bodies no longer carry — including, in the source run, guidance that had just been deleted for being unsafe.
