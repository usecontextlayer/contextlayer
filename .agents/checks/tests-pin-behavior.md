# tests-pin-behavior

Added or changed tests assert observable behavior tightly enough to catch the regression they exist for, and stay decoupled from implementation shape.

**Verdict test:** for each added/changed test, ask two questions. (1) Would it survive an internal refactor unchanged? (2) Would it fail if the behavior it guards regressed? A "no" to either FAILs.

## FAIL when

- Assertions mirror implementation: exact subprocess argv/call shapes, spies on internal helpers, private intermediate state, snapshots of internal structure — a benign reorder or refactor breaks the test with zero behavior change. (Full standard: AGENTS.md → "Assert on the Contract, Not the Inside".)
- An assertion is too loose to flip: `toContain("contextengine")` "pinning" a rename to `contextengine-synthesizer` passes against the old value too. The assertion must reject the pre-change state — exact match, or a fragment unique to the new value.
- A fixture hand-fabricates an external system's output (SDK message sequences, API payloads, stream orderings) where the real dependency could have been DRIVEN instead — at the lowest tier that can host it, which for most SDKs is the unit tier (they hand you the seam). Captured fixtures are the fallback when nothing can host the real thing, never the fix. (Full standard: AGENTS.md → "Exercise the Real Dependency".)
- A test asserts what our code hands a dependency rather than what the dependency then DOES with it — a hook's return value restated instead of the events the SDK actually sends, a request object inspected instead of the response a real client produces. The observable contract is on the far side of the boundary.
- Golden files are hand-authored where a committed generator driving real runs should produce them.
- An exact equality assertion is loosened to a tolerance (`toBeCloseTo`, an epsilon literal, `abs().lessThan(…)`) to make a residual pass. A residual is a finding, not noise.
- A test is framed around a prior bug's literal symptom — asserting the old broken output no longer appears — instead of asserting the correct idiomatic behavior. (Bugs DO get regression tests; they observe behavior, they don't enshrine the old symptom's exact values.)
- Production code grows test-only seams: `*ForTest` exports, test-only branches, cross-layer hooks that exist solely to make code testable instead of an idiomatic injection boundary.
- A correctness-critical, pure, invariant-bearing algorithm is added or changed with only hand-picked example tests where property-based tests (fast-check) would exercise its stated invariants.

## Do NOT flag

- Unit-scope behavioral tests — behavioral does not mean end-to-end-only; the boundary is the unit's public contract.
- Fixtures for data this project itself defines and owns.
- A hermetic fake standing in for an external system in a CI-runnable tier, WHEN the behavior it imitates is pinned against the real dependency in the tier that can host it and the fake is anchored to that. The fake is how CI keeps coverage of our own logic; the integration test is what keeps the fake honest. Flag the fake only when no such anchor exists. (Ruled 2026-07-28 during the guest-death review: scripted exec events in the unit tier are correct precisely because a real-guest test pins what a guest actually emits.)
- A real behavior deliberately left UNASSERTED because it measured non-deterministic, where the test records what was observed and why it is not assertable. That is a finding, not a coverage gap — asserting it would only pass when the flake fell the right way, and a test that launders a coin flip into a claim is worse than none.
- Test edits that track a *deliberate* behavior change made in the same body of work.
- CVA-variant class proofs: asserting a variant's styling class (`text-success`, `font-medium`, …) proves the variant exists in the CVA — the class IS the observable contract of a variant. (Ruled 2026-07-14 during the Table component review.)

## Calibration

> "i need the tests to be behavioural tests that test behvaiour and not implementation details … and i want them to cover all of the behavioural cases we have"

> "Bit-exactness is sacred: never loosen a `.isZero()`/`.equals()` assertion to paper over a residual. A residual is a finding."
> "you really should be capturing/using real sdk payloads … if you have an sdk, exercise the sdk itself. this is the true defintiion of tests-pin-behaviour and prevents the same kind of bullshit … inventing shit. using the sdk prevents that"
> "this is why we have different layers of integration tests. so that we don't have to capture fixtures for unit tests and we can exercise the real library in the appropriate testing environment. testing something in the right layer directly is MUCH BETTER than capturing fixtures."
