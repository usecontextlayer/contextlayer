# fail-loud

Failures surface loudly; the change under review adds no unrequested fallback, silent swallow, or plausible default on an unhappy path.

**Verdict test:** for every added or changed handling of a missing, invalid, unknown, or failing condition — does the condition surface (throw / propagate / exit non-zero / loud error), or does the code keep going on a substitute? An unrequested substitute FAILs.

## FAIL when the change adds

- `?? default` / `|| default` masking a value the design requires (`config.url ?? DEFAULT_URL` where a missing URL is a bug).
- A try/catch that returns a default, continues, or logs-and-proceeds where the caller needed to know (`catch { return [] }`).
- A dispatch/translator over *external* input (parsed JSON, SDK messages, events) whose default branch silently drops, passes through, or coerces unknown cases. The unknown branch must throw and include the unhandled value.
- A switch/if-chain over a discriminated union without an `assertNever`-style exhaustiveness guard, or with a permissive `default:` that tolerates unlisted variants.
- An unimplemented / not-yet-wired option stubbed to return a plausible no-op or default instead of `throw new Error("not implemented: …")`.
- A required secret or env var made lazy/optional, or given a fallback, to placate a build or test.
- A translation/coercion layer that can silently drop or rewrite fields of user-supplied config — forward it verbatim or fail.
- A known domain-invariant violation silently reconciled, coerced, or normalized instead of raised (Σ parts ≠ derived whole → quietly adjust one side).
- Clamping/flooring a value whose out-of-range signal is information (`Math.max(0, cash)` hiding overspend the author wants to see).
- A must-exist extraction/lookup (selector, index, registry get) returning null/empty/partial output instead of aborting before any output is produced.
- CI/scripts: `continue-on-error: true`, `|| true`, or swallow-and-proceed around a step whose failure is real (publish rejection, auth failure).

## Do NOT flag

- Defaults that are a *designed, valid state* — `title ?? "Untitled"` where absence is legitimate. The test: per the design, is the absent/invalid state an error, or a real state?
- Read-only status/diagnostic surfaces: these should degrade gracefully — partial info plus a prominent "X unavailable" warning — rather than hard-fail the command. (Data/capture paths still fail loud.)
- Boundary validation that throws — that IS fail-loud.
- A fallback that was explicitly requested or sanctioned.

## Calibration

> "NO FALLBACKS OF ANY KIND WITHOUT PERMISSION. NOT JUST UI FALLBACKS. NO FALLBACKS IN file reading, database lookup, network calls, ANYTHING"

> "if it gets a message from claude it hasn't been taught how to handle, it should fail loudly."
