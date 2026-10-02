# right-layer

Logic lives in the layer that owns its concern; data is transformed once at the boundary and flows through the core in one shape.

**Verdict test:** for each added block of logic, name the layer its file belongs to (entry/shell, boundary, core/model, presentation, generic infrastructure) and the concern the block implements. If the concern's owner is a different layer, FAIL.

## FAIL when

- A module positioned as generic/domain-agnostic gains inline domain branching — `type === "Action"`, named business entities, domain field lists — instead of receiving domain as data/params or delegating to a clearly-bounded domain module.
- UI/presentation code derives domain values: arithmetic producing business figures ($/share, sums, rates), or lifecycle conditionals hiding data (`if (sold) return null`). The UI is a pure projection; absent values must be absent *in the produced data*; the model is extended to surface what the UI needs.
- The presentation/read layer does file I/O or parses raw content the data layer owns.
- Display/iteration order is fixed by a downstream `.reverse()` or re-sort instead of building the source collection in canonical order.
- The same data is converted between equivalent shapes at more than one point (nested↔flat, a join re-done downstream) — join/normalize once at the edge, then one shape travels.
- Decision/core logic is interleaved with side effects (fs, network, subprocess, `Date.now()`, sleep) so it can't be exercised without mocking — functional core, imperative shell; effects are injected or pushed to the edges.
- Process lifecycle (`process.on("SIG*")`, `process.exit`) appears in shared/library/multi-consumer code instead of the single executable entry point.
- An entry point hardcodes a decision the downstream surface already owns (a launcher pinning a default sub-route the surface's own loader selects).
- A function reaches around its layer: host preparation inside a guest-boot function, a consumer hand-assembling internals its factory should resolve.

## Do NOT flag

- Formatting and layout computation in UI (Decimal→string, pixel/index math for rendering) — presentation work belongs to presentation.
- I/O in the shell/boundary — the imperative shell is *supposed* to be imperative.
- Domain logic inside a clearly-bounded domain module — domain code is fine where domain lives; the violation is leakage into layers meant to be generic.

## How to inspect

Identify the layers actually present — read package/module names, entry points, existing seams. The tree defines the architecture; judge placement against *this* codebase's layering, not an abstract ideal. Then place each added block: which layer owns this concern here?

## Calibration

> "AS A RULE. YOU SHOULD NOT BE DOING CALCULATIONS IN THE UI LAYER. … THE MODEL MUST REPRESENT ALL DATA. UI IS A PURE PROJECTION."

> "domain-specific functions are okay, as long as they're wrapped up in the right spot"
