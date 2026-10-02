# root-cause-not-symptom

A fix resolves the underlying cause; the change under review contains no code whose only job is to compensate for, suppress, or dodge a problem fixable at its source.

**Verdict test:** for every added guard, catch, retry, suppression, or verification step — name the condition it handles. If that condition cannot actually occur, or exists only because an unfixed root cause upstream keeps producing it, FAIL. Heuristic: a bug-fix that only adds and deletes nothing probably patched a symptom.

## FAIL when the change adds

- Null-checks / try-catch / defaults guarding states that cannot occur given the types, config, or upstream guarantees (`if (user == null)` inside a function typed to take `User`; a `cookie`-strategy branch when config pins the store to `database`).
- A tolerance layer for malformed data the system itself wrote (a `RunRecordReadError` + skip-on-parse-failure branch) instead of repairing/migrating the data and trusting the schema.
- A bounded retry-with-sleep loop papering over a timing/ordering/propagation race that correct sequencing would eliminate. One plain invocation plus one non-looping verify-and-hard-fail is fine.
- Checker suppression instead of a fix: `@ts-ignore`, `@ts-expect-error`, `biome-ignore`, `eslint-disable`, `as any`, `as unknown as X`, gratuitous `!` or `?.` added to quiet a diagnostic, or a lint/type rule downgraded/disabled to dodge a real, fixable violation.
- A dev-time safety mechanism disabled or defeated to mask a bug: React StrictMode removed, a run-once ref guard added, a cleanup deleted to stop double-invocation symptoms.
- A postbuild check, CI validation step, or runtime guard whose sole purpose is *detecting* a misconfiguration that could simply be fixed at its source.
- Publish-time manifest mutation (`npm pkg delete …`, sed on package.json) compensating for deps that should be declared correctly in the committed manifest.
- Arbitrary defensive ceremony: magic size caps, defensive timeouts on legitimately-slow operations, re-validation of values the types already guarantee — guards not tied to a named, real failure mode.

## Do NOT flag

- Validation at genuine external boundaries — untrusted input SHOULD be checked (owned by `boundaries-and-types`).
- Guards for named, real risks: a sync-eval timeout that would otherwise freeze the event loop, a path-traversal check.
- A narrowly-scoped config disable where the rule is a documented genuine false positive for that file class.
- A catch that responds *specifically* to a real, expected external failure with a real response — not log-and-continue.

## Calibration

> "I don't want this to be a guard fix. I want tsc to compile properly"

> "no need to add extra guards … just solve them idiomatically and move on"
