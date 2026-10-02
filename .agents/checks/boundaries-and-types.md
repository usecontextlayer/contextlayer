# boundaries-and-types

External input is validated once at the boundary through a schema; inside, types are trusted; invariants ride in the type system, not in runtime policing.

**Verdict test:** trace each new external input (JSON, env, config, request, file) to where it is validated. It must cross exactly one schema at the boundary and arrive inside as a resolved, non-optional, trusted type. An invariant expressible in the type must live in the type — and the first invariant of any minted contract type (a view type, a return value, a cross-layer payload) is its state space. Enumerate the real states the design has (loading, empty, nothing-selected, ready, failed, …) and compare them with the states the type can express: they must correspond one-to-one. A mismatch in either direction FAILs — a type that can express a state the design forbids (an illegal state representable; restructure the type until it isn't), or a real state left without a named variant, hiding in an unmarked `null`/`undefined`, a sentinel, or a combination of flags, so the consumer is forced to interpret what absence means. `null` never carries semantic meaning; a state worth distinguishing is worth a named variant in a discriminated union or result type, even when only one such state exists today.

## FAIL when

- JSON/external input is parsed with hand-rolled narrowing — `typeof` chains, `Array.isArray` guards, `as Record<string, unknown>` casts, a bespoke `parseX` function — instead of a schema (`schema.parse(JSON.parse(raw))`).
- A new config field is consumed by core code without being declared in the boundary schema, or is validated ad-hoc deep inside instead of at the edge (with its default, where one exists).
- A default is applied downstream — `x ?? default` in consumers, `T | null` propagated inward — instead of resolved at the config/boundary layer so the inner type narrows to plain `T` and the rest of the code is none the wiser.
- A shared or multi-tenant service reads per-tenant/per-workspace values from ambient `process.env` instead of explicit caller-supplied args; or `process.env` reads and cross-cutting constants are scattered across modules instead of centralized in one boundary module (`env.ts`) that validates and defaults.
- A schema is declared but never `.parse()`d at the enforcement point (decorative), or is non-strict where authored/untrusted input needs unknown-key rejection.
- Mutually-exclusive states are modeled as optional sibling fields plus a runtime "exactly one supplied" check, where a discriminated union makes the illegal state unrepresentable — the union deletes the check.
- `null`/`undefined` is given semantic meaning at a designed contract — a view type, return value, or payload where the consumer must interpret what absence *means* (loading? nothing selected? empty? failed?). States get named union variants; `null` gets to mean nothing. Escalating tells: one null covering two distinct states, or a sibling type on the same surface already modeling the same lifecycle as a discriminated union.
- A multi-outcome operation signals outcomes through shape instead of names: `T | null` where callers distinguish more than "present"; sentinel values (`-1`, `""`); parallel flags (`isLoading` plus optional `data`) representing more combinations than real states. Return a discriminated union / result type that names each designed outcome.
- A hand-declared type duplicates an authoritative schema it should be derived from (or assignability-checked against), so drift compiles clean instead of breaking `tsc`.
- A domain quantity the codebase already models with a branded type is passed around as raw `number`/`string`, or brand values are minted by ad-hoc `as` casts instead of the smart constructor.

## Do NOT flag

- Throwing at the boundary on invalid input — that is correct (`fail-loud` territory).
- Greenfield code in a codebase with no branded-type convention — do not demand brands speculatively; flag only divergence from an established convention.
- Legitimately-global settings read from env inside the designated boundary module.
- Redundant re-validation of already-trusted internal values — real, but owned by `root-cause-not-symptom`.
- Null as plain absent data on a leaf field (`email: string | null`) that no consumer branches on to choose a mode — null-as-datum is fine; null-as-state is the violation.
- Platform idioms at platform seams: React's `return null` for "render nothing," `Array.find`/`Map.get` results consumed where they're produced. The rule governs contracts this codebase mints, not stdlib signatures.
- Demanding ok/err result types where the design says throw — result variants name *designed* alternative outcomes; they are not a channel to route failures around `fail-loud`.

## Calibration

> "for any json parsing or input parsing, we should just be using zod and unifying things into zod"

> "set the default in engine-config.ts and then the type can be narrowed to just bool instead of bool | null and the rest of the code is none the wiser"
