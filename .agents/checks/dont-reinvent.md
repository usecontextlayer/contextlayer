# dont-reinvent

New code must not re-implement something that already has an owner — in this repo or in a library; it routes through the existing canonical path.

**Verdict test:** for each new function/type/branch of logic under review — does this job already have an owner (an existing repo function/schema/abstraction/pattern, a stdlib primitive, an installed library)? A finding MUST name the existing owner (`file:line` or library API). If you cannot name what is being reinvented, there is no finding.

## FAIL when the change adds

- A second implementation of logic that exists elsewhere in the repo (a duration-string schema rewritten, a translator living in two packages, a path-helper re-rolled).
- A parallel abstraction re-modeling a responsibility an existing concept owns (an `Executor` family beside an existing `Engine`; a bespoke `Variant` wrapper where plain existing `Config` objects suffice).
- A parallel entry point beside a canonical one (a separate `graph()` traversal alongside the unified `query()` path; a mutation route that bypasses the single guarded chokepoint).
- An execute/apply path that re-derives the work-set its own plan/dry-run function already computes — execute consumes plan's output.
- A near-copy of a sibling file with only an identifier swapped (`cp ctxe.cjs ctxs.cjs` + `CTXE_`→`CTXS_`) when the identifier is derivable from the file's own context (its `package.json`).
- The same non-trivial helper pasted into a second file instead of extracted and imported — an existing copy IS an owner.
- A second consumer/observer/loop over a stream or collection an existing pass already iterates — fold into the existing pass.
- Hand-rolled standard primitives: relative-time formatting (`Intl.RelativeTimeFormat`), UUIDs, file locking (a JS lock library, not shelled-out `flock`), parallel-process exit-code juggling, or asymmetric codecs (`btoa` on one end, `Buffer.from(_, 'base64url')` on the other — one codec, both ends).
- A hand-built UI primitive an approved corpus already provides.
- A new integration hand-rolling a divergent enable/config mechanism when a sibling integration already established the earned pattern.
- A new CLI-framework/utility dependency for a job an existing in-repo script convention already covers plainly.

**Owner search order:** same package → shared workspace packages → Web/Node stdlib (`Intl`, `URL`, `crypto`) → already-installed deps. A brand-new dependency is a discussion, not a default.

## Do NOT flag

- **Missing abstractions.** Two similar-but-independent pieces of code with no existing shared owner are NOT a violation, and this check never recommends extracting a helper speculatively. Premature DRY is itself a failure (owned by `no-speculative-machinery`); the seam gets built when a real second consumer forces it.
- Deliberately-dumb single-path inline code that a library could shorten but that duplicates no owner and pulls no new dependency.
- Divergence that is an explicit, argued, sanctioned decision.

## Calibration

> "HOLD ON. WHY ARE YOU DUPLICATING DURATION_SCHEMA LOGIC???"

> "ideally you're importing the exact function and just using it. if you need to refactor to make that code shareable, do it"
