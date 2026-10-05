# PROCESS-v1: idea → spec → implementation design → fresh eyes → slices

The end-to-end development process. `superpowers:brainstorming` governs *how* to run a brainstorm (one question at a time, options with a recommendation, lock each thread); this document governs *what the process is* — the phases, their artifacts, and their gates. `contextlayer/IMPLEMENT-v2.md` remains the law of the final phase, unchanged.

**Why two brainstorms.** A single brainstorm produces a spec that locks the outcome — and quietly ships the implementation path as the agent's unexamined defaults. The agent's pattern-following choices *feel* mechanical to it, so IMPLEMENT-v2's pause-on-judgment never fires on them, and the human discovers the divergence at deploy-prep or review — the most expensive possible moment. The founder-contact build is the recorded instance: "token endpoint in slate-platform" was agreed as words, but nobody traced that slate-platform runs in the customer container while slate's UI server runs on Vercel, so the feature's config silently split across two Doppler projects and surfaced as a surprise weeks of context later. The HOW deserves the same explicit agreement discipline as the WHAT — a separate session of it, because mixing the two lets implementation assumptions ride in under product momentum.

## Phase 1 — Outcome brainstorm: the WHAT and the WHY

Run a brainstorm session to decide the outcome, the features, and the scope of what we're building. Product decisions only — framing, behavior, boundaries, what's deliberately out of scope. Resist solving implementation here; when an implementation concern forces itself in (a hard constraint, a cost cliff), record it as a constraint on the outcome, not as a design. The result is written down as the spec's first half: **Problem, Decisions (each with its why), Out of scope, Open items** — the house format. This document is the *what* and the *why* to build. Spec location follows the standing convention: engine/multi-project work → `internal/in-progress/`, web work → `web/docs/in-progress/`.

## Phase 2 — Implementation brainstorm: the HOW

Then RESTART brainstorming — same discipline, fresh start, new subject: **architecture, components, data flow, error handling, testing**. This is not a formality pass; every load-bearing choice gets options + recommendation + explicit user pick, exactly like phase 1. Cover at minimum:

- **Ownership**: which package / plane / process owns each new piece, and why that home rather than its neighbors.
- **Data flow, end to end, including deploy time**: trace every new config value from its store (which Doppler project/config) through injection to the process that reads it, and every runtime request across its process boundaries. A seam that crosses planes (browser ↔ platform ↔ third party; Vercel ↔ customer container) is precisely what this phase exists to surface.
- **Error handling**: the failure states that exist, what the user sees in each, and which errors are deliberately loud.
- **Testing**: what gets a unit test, what only an e2e can verify (name the empirical unknowns), and what the verification of "done" is.
- **New dependencies and new patterns**: each named explicitly — both require sign-off per the repo rules, and this is where that happens, not mid-slice.

The agent's pattern-following defaults are PROPOSALS in this phase, not decisions. Write the outcome down as a separate **"Implementation design"** section in the SAME spec document. This is the *how* to build.

## Phase 3 — Fresh eyes

Run `/fresh-eyes` on the completed document: a cold-context adversarial review — placeholders, contradictions between the two sections, ambiguity, untraced seams, scope creep, and the specific question "what would surprise the implementer or the deployer that this doc doesn't say?" Findings are resolved into the document before any code exists. Fresh context is the point: the reviewing context must not be the one that wrote the doc.

## Phase 4 — Implement per IMPLEMENT-v2

Then apply the IMPLEMENT-v2 philosophy unchanged: no implementation plan, one small vertical slice at a time in a faux worktree, check-ins between slices, and PAUSE the moment a judgment, taste, or scope decision appears. Phase 2 is what makes that pause rule sufficient: with the big shape pre-agreed, the judgments that remain really are slice-local — and anything that contradicts the Implementation design section is a stop-and-ask, never a silent adaptation.
