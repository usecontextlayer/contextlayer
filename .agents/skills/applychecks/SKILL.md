---
name: applychecks
description: Use when applying a repo's `.agents/checks` standards to a branch — runs one group of checks per codex run, which edits the working tree directly, then reviews what it changed; a sequence of runs can cover the whole branch or a large branch chunk by chunk. Groups are functionality, layering, ownership, testing, and language. Invoke as "run the language group", "applychecks layering", "run all five in order", or similar.
---

# applychecks

Hand one group of `.agents/checks` to codex with edit rights, let it fix what it finds, then read what it did.

You are the user's collaborator here; codex is a tool you dispatch. It writes the code, you form a view on it, and the conversation continues with you.

## The groups

Each codex run applies one group. The group decides which check files reach codex — **only those files, never the whole directory.** The default sequence is all five groups in table order; the order is intentional.

| group | check |
|---|---|
| `functionality` | `no-speculative-machinery` |
| `functionality` | `behaviour-pays-rent` |
| `functionality` | `fail-loud` |
| `layering` | `root-cause-not-symptom` |
| `layering` | `right-layer` |
| `layering` | `boundaries-and-types` |
| `layering` | `contextlayer-seams` |
| `layering` | `monorepo-mechanics` |
| `ownership` | `dont-reinvent` |
| `ownership` | `delete-the-old-world` |
| `testing` | `tests-pin-behavior` |
| `language` | `names-are-concepts` |
| `language` | `comments-say-what-code-cant` |
| `language` | `prose-matches-code` |

Groups name check files in the repo's own `.agents/checks/`. A repo with a different set uses its own; several checks declare their own applicability and stand down elsewhere. If a group names a check the repo does not have, drop that line and say so — never invent a path.

**Each run reviews the cumulative branch diff within its scope.** Without chunks, that is the whole branch; with chunks, it is the branch diff for the chunk's paths. `origin/main...HEAD` after group 3 includes what groups 1 and 2 wrote to those paths — that is deliberate, and it is what makes the ordering pay off. It holds only while each run's edits are committed before the next run starts; *Committing* below says who commits.

## Chunks

A branch too large for one run to review well is split into chunks by path. A chunk's scope is the same range with a pathspec: `origin/main...HEAD -- <paths>`. The pathspec names what is under review; codex may still edit outside it when a fix needs to.

- **Draw chunks by package, following the data upstream first** — primitives before the service that calls them, the service before its client. When a downstream chunk is reviewed, the contracts it consumes have already been through every group.
- **Never chunk by commit.** Later commits rewrite what earlier ones added, so a per-commit range reviews versions of files that no longer exist.
- **Each chunk gets every group, in table order, before the next chunk starts.** HEAD advances with every commit, so the worktree contains all earlier groups' and chunks' work even when the current chunk's pathspec excludes it from the diff.
- **A pathspec splits renames.** A file moved across a chunk boundary shows up as an add in the chunk that holds its new path and as a delete in the chunk that holds its old one, so moved code is reviewed as if the branch wrote it.

## Before firing

**codex MUST run against a faux worktree — a `<repo>-<branch>` sibling clone, created by `setup-faux-worktree`.** Never a primary checkout (`contextlayer/`, `web/`, …), and never the workspace root. codex edits the tree directly with no read-only mount between it and the files; a faux worktree is disposable and a primary checkout is not. This governs codex's `-C`, not your own location.

**You are almost certainly not inside the worktree.** Sessions run from the workspace root, which is not a git repo — so every git command you run needs `git -C <worktree>`. A bare `git status` fails there.

**The tree must be clean:** `git -C <worktree> status --porcelain` returns empty. Otherwise codex's edits and the user's are indistinguishable afterwards, and the review step has nothing to read. **If it is not clean, stop, say what is dirty, and wait for the user** — committing or stashing work you did not produce is theirs, never yours. A previous run's work is committed under the commit policy (*Committing* below).

**Run `git -C <worktree> fetch origin` first.** The scope is measured against `origin/main`, which is a cached ref that only moves on a fetch — in a worktree nobody has fetched in, it rots exactly like local `main` does. Fetching touches remote-tracking refs only: no working tree, no local branches, so it neither dirties the tree nor collides with the no-git-state rule, which binds codex and not you.

**codex reads the worktree's `AGENTS.md`, checks and planning instructions, not the primary checkout's.** A branch cut before a change to them carries the old versions, and codex is briefed from them — so a retired workflow described there is a live instruction as far as this run is concerned. After the fetch, ask whether `main` changed them since the branch point:

```bash
git -C <worktree> diff --no-ext-diff --stat HEAD...origin/main -- AGENTS.md CLAUDE.md .agents/checks .agents/PLANS.md
```

Empty means `main` has no net changes to these files since the branch point. Anything listed is an upstream standards change: tell the user; rebasing is their call. The branch may already contain equivalent edits, which this command does not establish. Do not compare against the primary checkout instead — the branch's own edits to these files show up there as differences, and they are not drift.

**Then put these to the user in one short message and wait for a go-ahead. Never fire codex without it.**

- the spec — an `internal/in-progress/…` file
- the scope — `origin/main...HEAD`, and the chunks with their pathspecs when the branch is split
- the groups — all five in table order unless the user named others
- that you are about to run codex against that worktree, and with which model and effort: `gpt-6-astra` at `xhigh`, or `max` for a large changeset
- ask the user to choose a commit policy for the sequence (*Committing* below) and say whether it includes pushing; carry forward any choice they already made

Use `origin/main`, never local `main`: a faux worktree is a clone whose local `main` freezes at setup and rots from there — 51 commits stale is normal, and diffing against it hands codex fifty commits of other people's landed work as though this branch wrote it. Use three dots, never two: `origin/main...HEAD` diffs from where the branch diverged, so a base that has moved on does not show up as the branch reverting it.

**The spec states outcomes — what the work must achieve — and the checks judge how it is achieved.** Every implementation detail the spec settles in advance is one the checks can no longer touch, so keep sanctioned exceptions out of it: a spec that records how things were built leaves the checks little to check. Make sure the spec is current and states the outcome before firing; when there is none, write a short outcomes-only one with the user first. Point codex at it; never paraphrase it.

## Committing

codex never commits, so a run that changes files leaves the tree dirty and the next run's clean-tree precondition fails until someone commits. The user names one policy at the go-ahead, and it holds until they change it:

- **pause** — after every run, report and wait. The user commits, or tells you to.
- **flow** — a run that changed nothing goes straight on to the next; any edit or `-- NEEDS REPLY --` stops for review.
- **driver commits low-risk** — a run that changed nothing goes on; a low-risk run you commit, and push when the user said to, then go on; anything else waits for the user.
- **commit every run** — commit each run's changes, and push when the user said to, then go on; a run that changed nothing goes straight on. Stop only for `-- NEEDS REPLY --`, a red gate, or something your review would push back on. Those are the user's judgement calls.

**Low-risk** means all of: the gates are green in your re-run; codex did not pause; every hunk keeps behaviour the same — dead code with no remaining callers deleted, unused imports or exports removed, local renames, types tightened with no runtime effect, formatting, typo-level wording fixes; and your review (*After*) flags nothing. **Never low-risk:** a change in runtime behaviour, or in an exported API, schema, wire shape, env var or error shape; a deleted or rewritten comment that carried rationale; a test assertion changed, loosened or deleted; any edit to `AGENTS.md`, `CLAUDE.md` or `.agents/`; a new dependency; a red gate, flaky or not; the tree changing under `pnpm run check`. A run that mixes low-risk hunks with others waits whole.

When you commit, stage exactly the run's files — every path `git -C <worktree> status --porcelain` lists, new files included — so nothing else rides along and nothing codex created is left behind.

## The prompt

Copy `prompt.md` from this skill's directory to `<rundir>/prompt.md` (*The run* below names the run directory) and replace every occurrence of all five placeholders. Spec and check paths are **relative to the worktree**, codex's working directory, to avoid accidentally reading another clone's copy. The run directory is absolute.

- `<GROUP>` → the group name, bare: `functionality`, `layering`, `ownership`, `testing`, `language`
- `<SCOPE>` → `origin/main...HEAD`, or `origin/main...HEAD -- <paths>` for a chunk
- `<SPEC_PATH>` → the spec, relative: `../internal/in-progress/<spec>.md` for a worktree beside `internal/`
- `<CHECK_FILES>` → one bare path per line, `.agents/checks/<name>.md`, in table order
- `<RUNDIR>` → the run directory, absolute; codex writes its logs there, and its ExecPlan when it uses one

`workspace-write` restricts writes, not reads, so codex reads the spec through `../` even though it sits outside the sandbox root.

The prompt's closing summary asks for uncertainties, concerns, reflections, curiosities and opportunities. That section is the most valuable output of a run. The edits are visible in the diff; this is the only channel for everything codex saw and did not act on.

## The run

Make one directory outside the repo to hold the prompt and every output:

```bash
mktemp -d /tmp/applychecks-<group>.XXXXXX          # one run
mktemp -d /tmp/applychecks-c<N>-<group>.XXXXXX     # a run in chunk N
```

It prints a path like `/tmp/applychecks-language.Xf3Kq9`. **That path is the run directory — substitute it wherever `<rundir>` appears below, literally.** Shell state does not survive between commands, so capturing it in a variable and referring to `$TMP` later leaves every redirect writing to the filesystem root. **Tell the user the path** — it is where the run lives if this session dies.

```bash
# copy prompt.md to <rundir>/prompt.md and fill it

codex exec --json \
  -s workspace-write -C <worktree> -m gpt-6-astra \
  --add-dir <worktree>/.agents \
  -c model_reasoning_effort="<effort>" -c approval_policy="never" \
  -c project_doc_max_bytes=1048576 \
  --disable plugins --disable apps \
  -o <rundir>/last-message.txt - < <rundir>/prompt.md \
  > <rundir>/events.jsonl 2> <rundir>/stderr.txt
codex_exit_code=$?
echo "exit=$codex_exit_code" > <rundir>/exit.txt
exit "$codex_exit_code"
```

`<effort>` is the one you named at the go-ahead.

**Run it in the background** (`run_in_background`) — expect 10–60 minutes now that codex runs the gates, well past any foreground timeout. Tell the user where the run directory is.

**Redirect the event stream to a file; never pipe it.** A pipe into anything that exits early — `| head`, `| grep -m` — closes the read end, which kills codex mid-run and takes its work with it. The events file is also the only record if this session dies before codex finishes.

`exit.txt` puts codex's exit code in the run directory. Without it the code exists only in the harness's completion notice, and the run directory stops being a complete record.

`project_doc_max_bytes` is raised far past any real need because the default silently mutilates instructions. The 32 KiB default is a **cumulative** budget over the `AGENTS.md` chain, and overflow is a raw byte cut whose warning goes to a log file rather than the terminal — so the tail of the last file read just disappears with nothing said. Every run depends on the complete repo instructions, including the tail of the last file in that chain. Setting the value to `0` does the opposite of what it looks like: it disables project docs entirely.

`--disable plugins --disable apps` stops codex's boot-time marketplace fetch, which injects tools this run never sanctioned, including a git-push skill.


`--add-dir <worktree>/.agents` is what lets codex edit the skills and checks the prompt allows it to. `workspace-write` refuses writes under `.agents/` even inside the worktree (`operation not permitted`); naming it as a writable root lifts that.

Never add `--ephemeral`. It prevents subagents: an ephemeral run persists no thread, so every collab spawn fails (`collab spawn failed: no thread with id: …` — stderr only, nothing on the terminal) and codex silently carries on solo, ignoring the prompt's "use subagents liberally." The only cost of omitting it is a persisted session in codex's state dir.

## When codex needs a reply

codex cannot ask you anything mid-run, so the prompt tells it to stop and end its final message with `-- NEEDS REPLY --`. Read the latest turn's output files (*After* below). (`request_user_input is unavailable in Default mode` in stderr is codex reaching for a channel `exec` does not have — not a failure.)

**A paused run reads exactly like a finished one**, but its edits may be partial and its gates may be unrun. Relay everything codex wrote and wait for the user — it may be one question or several, or a judgment call rather than a question. **Never make the user's decision yourself.** Before you relay, verify the claims its question rests on — that a dependency is already in the repo, that a file says what codex quotes — so the user decides on facts rather than on codex's word. Present any factual corrections with their evidence, separately from the decision you are asking the user to make.

The one pause that is not a decision is codex asking the driver to run gates its sandbox blocks — the prompt tells it not to, but it still happens. That asks for evidence: run those gates unsandboxed on the tree exactly as codex left it, and resume with the results.

Then resume the same thread with their reply. The thread id is the first line of `events.jsonl`:

```json
{"type": "thread.started", "thread_id": "019fb865-5ddf-78d0-9d53-99f9678699bd"}
```

Write the reply to `<rundir>/answer-N.md` and keep the same run directory, numbering each turn from 1 (`answer-N.md`, `events-N.jsonl`, `last-message-N.txt`, `exit-N.txt`) — one codex thread, one record.

```bash
cd <worktree> && codex exec resume --json \
  -m gpt-6-astra \
  -c model_reasoning_effort="<effort>" -c approval_policy="never" \
  -c sandbox_mode="workspace-write" \
  -c 'sandbox_workspace_write.writable_roots=["<worktree>/.agents"]' \
  -c project_doc_max_bytes=1048576 \
  --disable plugins --disable apps \
  -o <rundir>/last-message-N.txt \
  <THREAD_ID> - < <rundir>/answer-N.md \
  > <rundir>/events-N.jsonl 2> <rundir>/stderr-N.txt
codex_exit_code=$?
echo "exit=$codex_exit_code" > <rundir>/exit-N.txt
exit "$codex_exit_code"
```

**Resume starts from your config's defaults, not from the thread** — that command repeats every setting on purpose, `<effort>` included: use the effort the run started with. Drop one and the run continues under rules nobody chose, with nothing said: a thread that ran `read-only` resumes as `workspace-write`, and the writable roots disappear.

`-s`, `-C`, and `--add-dir` do not exist on `resume` in any position, which is what the `-c` forms and the `cd` are for. `~` is not expanded inside a `-c` value, so write the path out. **A resumed codex runs wherever the shell is**, ignoring the cwd stored in the session, so that `cd` is the only thing keeping it off a primary checkout.

The reply carries the user's decision, anything that changed in the tree while codex was paused, and any factual corrections you verified while checking its premises, with the evidence. Correcting a premise does not authorize you to make the decision. codex still holds the original prompt — resume sends your message as a new turn and re-sends nothing.

A failed resume looks like a failed boot: non-zero exit, empty `events-N.jsonl`, no `last-message-N.txt`. **After** covers it.

## After

**First confirm it ran.** A codex that dies at boot — expired auth, a rejected flag, an unavailable model — leaves an empty diff, which reads exactly like "found nothing to fix." Read the latest turn's exit and stderr files, and confirm its last-message file is non-empty before believing anything about the result. For the initial turn, these are `exit.txt`, `stderr.txt` and `last-message.txt`; after a resume, use `exit-N.txt`, `stderr-N.txt` and `last-message-N.txt` for the latest `N`.

**Then confirm it finished.** A run ending in `-- NEEDS REPLY --` is paused, not done — take it to the user and resume it (*When codex needs a reply* above). Reviewing it as a result risks reporting partial edits and unrun gates as the outcome.

**Then read both halves of what it did:**

```bash
git -C <worktree> status --porcelain          # every file touched, INCLUDING new ones
git -C <worktree> diff --no-ext-diff          # the content of the edits
```

The status line is not optional. `git diff` shows tracked files only, and codex is forbidden from staging, so **every file it creates is untracked and invisible to the diff alone** — and a missed new file looks identical to codex having changed nothing there. Read new files directly. `--no-ext-diff` is not optional either: a git config can route `diff` through an external tool whose output is not a patch.

**Re-run the gates yourself, unsandboxed.** codex claiming they pass is a claim like any other, and this is the cheapest one to check:

```bash
bash <skill-dir>/gates.sh <worktree> <rundir>
```

`<skill-dir>` is this skill's own directory. The script runs every selected gate even after one fails, so you see every outcome rather than the first red, and it writes them to `<rundir>/gates.txt`. A run that changed nothing skips the per-run gates, because it produced no edits to verify. The build gate is `npx turbo run build`; the root `pnpm run build` delegates to the same workspace task.

The prompt explains why the ladder uses the aggregate `pnpm run check`. It is a mutating step — it runs `format.fix`, not `format.verify` — so **if the tree changes under it, that is a finding, not a tidy-up**: codex left unformatted code and its diff was not what it reported. The script records Git tree hashes before and after it (`tree-before-check.txt`, `tree-after-check.txt`), covering tracked and non-ignored untracked files as Git would stage them. It uses a temporary index and writes snapshot objects without changing the real index or any ref. Report different hashes as a formatter mutation; failed snapshots are recorded as red gates, not evidence of an unchanged tree.

**The driver verifies gates blocked by sandbox restrictions unsandboxed.** Do not skip that verification on the grounds that codex reported green: its summary must identify the commands and failures it actually observed.

**Read the group's check files before you review.** They are the standard codex was held to. Judged by a general principle instead, a pattern the check explicitly requires — an exhaustiveness guard `fail-loud` names, say — reads as ceremony and gets flagged as a defect.

**Then review through `choosing-the-idiomatic-shape` and `cutting-to-the-base-case`** — load both. Did codex add a shim, a wrapper, or a second way beside one that already exists? Did it add handling for a case — a guard, a fallback, a retry, a check, or a test built to exercise one? Each addition needs to earn its place by satisfying the assigned checks; functionality unrelated to them is a finding. Where the check names the pattern, the check wins over the lens. Report observations outside the group as concerns, separately from violations of the assigned checks.

Tell the user what you make of it. Lead with the run's size — files touched and lines added and removed, from `git -C <worktree> diff --no-ext-diff --stat` plus the new files `status` lists — and include any red gate in that opening line. Follow with what codex got right, what looks wrong, and what you would push back on. Verify anything load-bearing against the actual code before asserting it; a summary line is a claim, not a verdict. codex's own summary is in the latest turn's last-message file.

You do not edit codex's work. A disagreement goes to the user, with an offer to send it to codex as feedback (*Feedback to codex* below); the only edits you make are restoring what the user chose not to keep.

**When the user keeps part of a run,** restore the rest mechanically — `git -C <worktree> checkout -- <paths>`, and delete new files they rejected — never by rewriting. Then re-run the gates on exactly the tree you will commit, and commit under the policy.

Then the commit policy decides what happens next, and you carry on with the user.

## Feedback to codex

When the user takes up your offer — their usual answer to a disagreement — send your argument to codex as feedback, not an order, and let it decide. Resume the same thread (*When codex needs a reply* has the command and the numbered-turn record) with the point, your reasoning, and the evidence: `file:line`, the spec's words, the check's own text. Tell codex to verify for itself and weigh the argument against the checks, that it may keep, revise, or revert, and to finish with the same summary.

Then review the new state as you would a fresh run, gates included. codex may push back; when its answer rests on the text of the check, the check wins.
