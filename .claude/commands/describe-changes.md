---
description: Describe what a change set actually does between two refs/worktrees — organized outcome → behaviour → file, written as observable contracts so you can predict how the code now behaves and catch unexpected or missed work
argument-hint: "[ref|path] [ref|path]  (refs in this repo, or two worktree dirs; one arg = vs default branch)"
---

Goal: explain what the change set actually *does* — not what its commits claim — so the reader can understand how the code now works and spot behavior they didn't intend or work that looks missed. Do the whole thing yourself; do not delegate to a subagent.

## Step 1 — Resolve the diff range

Args: `$ARGUMENTS`

Interpret loosely:
- Two refs in the current repo → diff those two.
- Two directory paths → two worktrees/clones; use each one's `HEAD` (or `path@ref` if given). They may be separate clones that share history — run git inside whichever repo has both objects.
- One arg → compare it against the repo's default branch (`main`/`master`) or its upstream.
- Zero args → current branch vs its merge-base with the default branch.

**Default to a three-dot range** (`merge-base(A,B)..B`): describe what B introduced since it forked from A, not unrelated drift that landed on A afterward. Compute the merge-base explicitly and use shas, not branch names (a sibling clone's `main` ref may be stale). Only fall back to two-dot (`A..B`) if there is no common ancestor. State the exact range + sha pair you settled on before you start.

## Step 2 — Read everything (ignore the commits)

- **Ignore commit messages entirely.** Do not read `git log` subjects/bodies; do not let them shape or seed your findings. Work only from the code.
- **Read the full diff for every changed file.** Write it to a temp file (`git -C <REPO> diff <RANGE> > /tmp/dc.diff`) and Read the whole thing — never pipe through `head`/`tail`.
- **Read related code widely.** For each touched symbol, open the surrounding file and grep the repo for its callers, callees, config keys, types, schema, and tests. A diff hunk is not the effect — the effect is what the rest of the code now does. Trace it.
- **Trace every deletion and every removed config/env/CI/build key to its consumers.** grep for who still references the deleted file, symbol, or key before deciding it's harmless — a removed thing that something downstream still depends on is the highest-signal finding, never churn.
- You may flag issues (bugs, regressions, half-done work). Distinguish "this is what it does" from "this looks wrong."

## Step 3 — Output

The reader wants to *understand how the system now behaves*, not just see which files moved. Structure every branch as **outcome → behaviour → file reference**:

- **outcome / group** — bold; the capability this change delivers (nest sub-outcomes as needed)
  - **behaviour / rule / fallback** — the understanding-carrier (see "how to write it" below)
    - [sub-behaviour, if it has distinct parts]
    - `file` or `file:line` — bare leaf reference, nothing else on the line
  - `file` or `file:line` — a reference may sit directly under an outcome when not tied to one behaviour

**How to write the behaviour bullet — observable behaviour as a contract:** write each as a precise statement of *what is now true* — the triggering condition and the response — covering every branch, edge case, and fallback. They should read like acceptance criteria: "When workspace enumeration returns no workspaces, `/` remains at the empty root"; "On a first visit with multiple workspaces, `/` redirects to the alphabetically first one"; "On a failed session refresh, the last-known list is kept rather than cleared." The reader should be able to predict how the feature behaves in every case from your words alone. Focus on observable behaviour and contracts (inputs, outputs, conditions, guarantees), not on implementation steps. The reader's complaint is that "discovers the workspace" tells them nothing about what actually happens — your job is to make every branch and fallback explicit.

- Mechanical churn folds into the behaviour it serves; only genuinely unrelated churn gets its own outcome.
- Then a **"Watch out"** section — spend real effort here: the highest-signal items where the change may not match intent, a caller/config/test was left un-updated, validation or error handling was dropped, a default/contract shifted silently, or something looks incomplete. If you found none, say so plainly rather than padding.
