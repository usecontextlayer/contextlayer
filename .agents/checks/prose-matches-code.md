# prose-matches-code

Every comment, doc, and description the change under review touches or makes stale accurately describes the current code — and hard-earned rationale is present where it is load-bearing.

**Verdict test:** read every comment/doc/description in or adjacent to the changed code as a claim; check the claim against what the code now does. A false claim FAILs; missing required rationale FAILs.

## FAIL when

- A comment describes superseded behavior ("clamped to wall-clock" while the code now clamps to the sync horizon), or cites a removed/renamed type, arg, or path as current.
- A refactor silently drops nuance a prior comment carried — hard-earned constraints must survive the rewrite.
- A doc contradicts the code, or contradicts a code comment, on the same fact (field name, shape, behavior).
- Test titles / `describe` / `it` strings name the old concept while the body asserts the new one.
- A doc points readers at a path that doesn't resolve from the repo root, or a shipped/distributable doc references a dev-machine or sibling-repo path that won't exist where it is installed.
- A doc restates definitions/methodology/contracts a sibling doc canonically owns, instead of linking to the owner.
- A deliberate refusal or safety-critical guard lands without a comment stating what is intentionally not handled and why the guard matters (why divergence is not auto-resolved; why the ancestor check gates the operation).
- A provisional decision is buried as an inline magic literal instead of an OBVIOUS named constant carrying a fix-later comment.

## Do NOT flag

- WHY-comments stating constraints the code can't show — these are wanted. This check enforces accuracy; whether content belongs in a comment at all is `comments-say-what-code-cant`.
- Archived/historical docs (`internal/archived/` and equivalents) — tombstones; staleness there is intentional.
- Docs whose staleness predates the work under review and is untouched by it — *unless* this work is what made them stale.

## Calibration

> "can you add comments where your logic has been especially designed/hard-earned so that future editors don't fuck it up. make sure all of your comments are correct and up-to-date"

> "carefully verify … the accuracy of every single comment change and make sure your changes didn't drop important nuance in the comments"
