# no-speculative-machinery

The change under review builds only what the work needs now — no structure for a future that hasn't arrived.

**Verdict test:** for each added parameter, option, layer, transform, or clever branch — was it needed *now*? "We might need it later" FAILs: the option to build it later is worth more than the structure today.

## FAIL when the change adds

- Config knobs, env plumbing, schema fields, or function params for a value needed only as a fixed constant (guest-memory size, a timeout) — hardcode it.
- Lifecycle robustness nobody asked for: SIGINT/SIGTERM handlers, graceful-shutdown, teardown ceremony that isn't load-bearing for how the thing actually deploys.
- Privacy/sanitization machinery on speculation: PII masking, hashing, stripping, deriving — prefer the SDK's built-in toggle; solve the problem when it exists.
- "Smart" behavior where a single dumb path works: conditional dedupe, merge-on-conflict, skip-if-already-set detection, auto-normalization or rejection of inputs beyond what was asked.
- Premature optimization on a path that was fine dumb: incremental diffing, dirty-bit tracking, cache invalidation, memoization for an unmeasured cost — simple full resend/rebuild until asked.
- A new abstraction layer stacked on top without replacing or subsuming an existing one — new structures replace, they don't add indirection.
- **Premature DRY:** a shared helper/abstraction extracted for a second consumer that doesn't exist yet. Two similar code blocks are allowed to stay similar; the seam is built when a real second consumer forces it.
- New DSL vocabulary — bespoke operators/fields minted for a one-off case a bounded escape hatch already covers.
- A mode/config switch bifurcating behavior that is supposed to stay equivalent across its branches (a `streaming_mode` flag whose arms diverge).
- Speculative CI machinery: restore/save-split plus `always()` saves to warm failed runs, where default cache-on-success is acceptable.

## Do NOT flag

- Structure the work genuinely requires now, built properly. YAGNI is timing, not a ban on design — if you need it, build it, and build it correctly.
- A provisional hardcode surfaced as an OBVIOUS named constant with a "fix later" comment — that is the *required* form of deferral, not speculation.
- Robustness that is load-bearing for the real deployment. Verify against how the thing actually runs, not against a generic checklist.

## Calibration

> "my desire for low complexity is more important than my desire for privacy. we'll solve this problem _when we have it_. until then, i don't want more surface area to implement, debug, and think about."

> "no special de-dupe handling. generally our code should not be too smart"
