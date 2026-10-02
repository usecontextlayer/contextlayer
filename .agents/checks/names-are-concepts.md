# names-are-concepts

The change under review keeps the ontology tight — one concept, one name; every name promises exactly what its bearer does.

**Verdict test:** count the concepts, count the names. Two names for one concept, or one name spanning two concepts, FAILs. A name that promises less — or other — than its body does FAILs.

## FAIL when the change introduces

- Two terms for one concept across a feature's surface: a config field `daemonEnabled` paired with a derived `isPaused`; the same referent called by different words in adjacent code. One concept, one word, consistently.
- One name fused over two concepts: compound names (`validateAndSave`) or hedge names (`Manager`, `Util`, `Helper`) minted for new units. Two concerns means two functions.
- A function whose body exceeds its name's promise — host preparation inside `bootSandbox` — burying a concern no caller can see at the call site.
- Cryptic or abbreviated identifiers where a descriptive name is available — even when the descriptive rename is the larger change.
- Sibling artifacts breaking an established naming geometry (`{NAME}.render-spec.json` for one kind, an ad-hoc pattern for its parallel kind). Similar names claim similar concepts; different concepts must not get gratuitously similar names.
- A name erasing a distinction the code depends on: absolute vs relative (`period` vs `periodOffset`), local vs global frame, minted vs trusted provenance. The unmarked name claims the default — use it only when that's true.
- A flag/switch named for what it holds rather than what setting it does (`TRUSTED_SUB_ID` warns; `SUB_ID` doesn't).

## Do NOT flag

- Established idioms of this codebase (`XxxInput` types where that is the convention). Read the namespace the name joins; judge the geometry against its actual siblings, not abstract taste.
- Pre-existing names the change doesn't touch. (Old names left stale *by this change* belong to `delete-the-old-world`.)
- Most naming disputes are concept-count disputes: before flagging a "bad name," verify the underlying concept is well-drawn — a name that won't come out clean usually means a fused or misdrawn concept, and that is the finding.

## Calibration

> "don't use two words/concepts. either daemonEnabled with isEnabled or daemonPaused with isPaused."

> "hold on, can we come up with better/more-descriptive names, even if it's a larger change"
