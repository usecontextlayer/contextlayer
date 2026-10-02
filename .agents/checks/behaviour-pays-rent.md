# behaviour-pays-rent

Every handled condition specs a behaviour — a promise the system must keep from now on: named, tested, documented, and preserved by every future change. A loud failure specs nothing; it marks where behaviour deliberately ends. The change under review mints no behaviour it wasn't asked for.

**Verdict test:** for every condition the change newly handles, name the behaviour it specs — the mode, state kind, result arm, recovery path, refusal, or fallback the system now promises. Each specced behaviour must be warranted: asked for in the brief, or consciously decided in the design (spec, decision-site prose) — and warrant attaches to the surface that OWNS the behaviour, not to the model's vocabulary. One aftermath has one owner and one speaker: when an existing mechanism already owns a state, every other site that reaches it fails loud and names the owner — it does not grow its own arm. Rarity is not the test — a real, even routine condition still does not warrant a dedicated behaviour when a loud failure plus the existing owner already covers it. An unwarranted behaviour FAILs no matter how loud, well-logged, or well-built it is. The mirror binds equally: a region left unserved is not a finding when it fails loud. Heuristic: a change's specced-behaviour delta should trend toward zero — handling that deletes promises beats handling that mints them.

## FAIL when the change adds

- A new result kind, state variant, or enum arm minted at a call site for an aftermath an existing mechanism already owns. A second speaker for the same aftermath is a second promise even when it borrows the owner's exact vocabulary — "conforming" a site to the decided model by growing an arm there is this FAIL, not a migration; the site fails loud and names the owner instead.
- A dedicated recovery path — a rescue branch, a park-for-human state, an auto-repair arm — for a condition whose decided response is a loud stop.
- A refusal behaviour policing human misuse of an internal surface (author-identity checks, provenance sniffing): the rule lives in prose at the decision site; the guard is a new promise with its own failure modes.
- A graceful mode — serve-stale, best-effort continue, fallback-to-safe — minted where the design's answer is stop loudly. A mode is surface even when its logging is prominent; the loudness of the log does not pay for the promise.
- An in-contract path parameterized, generalized, or branched so an edge can share it — complicating the promise the happy path already makes.
- Behaviour resurrected for an edge a prior design deliberately deleted (`delete-the-old-world` owns the general form).

## Do NOT flag

- The loud throw itself, however routine or rare its trigger — a throw with a precise message specs nothing; it is never "missing handling."
- Warranted behaviour: asked for in the brief, or consciously decided and load-bearing — at the surface that owns it (a documented API contract honored at the client that owns the call; a decided convergence model at the reconcile that owns reconciliation). Warrant does not transfer: the decided model licenses no new arms at other call sites that reach the same aftermath — those sites fail loud and defer to the owner. Judge warrant from the brief, spec, or decision-site prose — not from your own sense of robustness.
- MISSING behaviour — never report "X is unhandled" or "invariant enforced nowhere" when the unserved region fails loud or the rule is documented at its decision site. Deliberate non-coverage is the design.
- A change that deletes behaviour — removes arms, states, or promises — in favor of a loud failure plus an existing owner: that is the desired direction, not a regression.
- Boundary validation of genuinely untrusted external input — tightening the input domain is not minting behaviour; owned by `boundaries-and-types`.
- Guards for conditions that cannot occur at all — real finding, but owned by `root-cause-not-symptom`.

## Calibration

> "i don't want to add any guards for humans/operators editing engine state by getting into docker. that's a stupid edge-case. but i do want to make the path for engine simple (as in, strip to essential complexity for the happy-path and 90% use-case, fail loud for edge-cases)"

> "i like to write code that solves 80%-90% of the conditions, and deliberately leaves edge-cases unfixed, as long as they fail loud."

> "this doesn't feel like the simplest fix. i want to add less arms and less behaviour. can we fail loud here?"
