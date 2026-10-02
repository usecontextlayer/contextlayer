# comments-say-what-code-cant

Every comment the change under review adds or rewrites says something the code cannot say, to a reader who is actually here, and will not silently rot.

**Read the whole corpus first, before judging any single comment.** `node --import tsx ./scripts/extract-comments-from-changeset.ts <range>` prints every comment and docstring in the touched files — whole, in file order, marking the ones the change added or rewrote. That listing is the lay of the land: what this code already explains, in what vocabulary, at what density. It is also the only view that answers the two questions a diff cannot, because in a diff every comment is met alone and passes on its own merits. Is this ruling already argued at another site? And does the rationale you are about to cut survive somewhere else — the difference between a correct relocation and a silent loss?

**Verdict test:** then read each added/rewritten comment and ask three questions. Could a reader write it just by looking at the code? Then it restates — FAIL. Can it become a lie without anything adjacent catching it (a volatile fact nothing local enforces)? Then it rots — FAIL. Is it addressed to an actor who works somewhere else? Then it is misplaced — FAIL. (Whether a comment is *currently accurate* is `prose-matches-code`; this check judges whether the content belongs in a comment at all.)

## FAIL when the change adds or rewrites

- A volatile claim about another system's behavior — a library's current internals, a vendor's storage model, an API quirk. **Volatile means that system would not call changing it a breaking change**; a protocol, a documented contract, or a standard is stable and belongs to the Do-NOT-flag case below. When the volatile claim is NOT why the adjacent code is shaped as it is, it is spec material — the comment at most links the spec that owns it. When it IS why, keep the CONSEQUENCE and cut the MECHANISM: what breaks without this code, in a form that survives their next refactor ("the backdrop paints over the dialog and its controls stop being clickable"), never their current way of causing it ("their backdrop carries inline `position: fixed`"). If the mechanism itself is load-bearing, make it checkable rather than asserting it.
- A comment a reader could reconstruct from the code alone: restating the adjacent line, the type, a flag name — or a test banner paraphrasing its own `describe`/`it` titles and assertions.
- A contract or warning whose actor is elsewhere ("callers MUST send the full scope set" stapled to a config object that never builds the request). Move it to the acting site; if that site is outside this repo, link the owning spec.
- The same ruling argued at a second site. One argument, one home: the site that owns the decision carries the WHY — for a hazard, the line whose edit triggers it; otherwise the unit whose contract it is — and every other site states only its own local fact, naming the owner in code terms (`see capture()`), never a path or a line number. Each copy passing on its own is not a defence: a ruling written twice gets corrected once and rots everywhere else.
- A dated self-audit breadcrumb with no actor and no action ("verified 2026-07-13: …", spec section numbers as provenance) — commits, specs, and run logs own that trail.
- A comment explaining or apologizing for HOW convoluted code works — the finding is against the code (extract, rename, simplify), not a license for the comment.
- Narration of the change itself ("now uses X", "moved from Y") — commit-message material; it is the author talking to the reviewer, noise the moment it lands.
- Archaeology — narrating the codebase's PAST as if the reader were there for it: "used to X", "previously", "the old script", a prior design recounted as history, an incident memoir ("stayed green for weeks"). Git history owns the past. When a past defect motivates a present constraint, only the timeless form belongs in the comment — what breaks WITHOUT the code as it is ("repeating the tail hands a second execute the previous one's 200") — never the memoir.

## Do NOT flag

- The non-obvious, domain-stable WHY the code cannot express ("a Microsoft token is single-audience, so Dataverse needs its own provider") — wanted even when it names another system. **Domain-stable means that system would call changing it a breaking change**: a protocol, a documented contract, a standard. Its current internals are not that, however true today. For deliberate refusals and safety guards this WHY is *required* by `prose-matches-code`.
- Tripwire comments stapled to the edit site so they fire when someone touches the dangerous line ("if you add a variant here, update getTypeNameByID") — here the future editor IS the actor.
- Why-NOT comments recording a deliberately-absent path ("no batching: N is tiny and this runs once") — negative information cannot be self-documented.
- Precision on data: units, what null means, invariants, boundary semantics — looks like it restates the type; it says what the type cannot.
- Interface docs on an exported surface carrying semantics the signature can't (edge cases, ownership, blocking behavior). A docstring that merely paraphrases the name still FAILs.
- Durable citations (an RFC, a standard's section number, an issue link) and machine-consumed markers — stable references, not breadcrumbs.
- Fix-later comments on named provisional constants — *required* by `no-speculative-machinery`.
- Volume as such — the defect is always the wrong KIND of content, never "too many comments"; do not reward terseness.
- The remedy for a true finding is a hierarchy, not reflex deletion: reshape the code until the comment is unneeded (rename, extract) → make the claim checkable (assertion, type, test) → relocate (acting site, commit message, spec) → delete. Point the finding at the highest rung that applies.

## Calibration

> "please don't include comments that could be untrue or will become stale. what is the purpose of these comments at all?"

> "can you update the comments in the code on that branch. it's quite verbose and possibly out of date"

> "we don't want archealogical comments here"
