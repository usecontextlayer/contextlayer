# tests-reuse-production

Added or changed tests reach production through its real contracts and composition; they never build a parallel implementation to obtain coverage. This is `choosing-the-idiomatic-shape` applied to tests, and it comes before `cutting-to-the-base-case`: find the production shape first, then cut the cases that shape cannot reach.

**Verdict test:** for each added or changed test, fake, fixture, or harness — does it carry a rule that production or another system owns, or run production along a path production never takes? A finding MUST name the owned rule or the bypassed production path and its owner (`file:line`). The remedy is ordered: the framework's intended test boundary or an existing production entry point first; then a reshape so production and the test call one function; only then drop the case. Consider the idiomatic production shape before dropping the case. This does not require implementing a refactor solely to obtain coverage.

## FAIL when

- Test support re-implements logic production already owns instead of calling it — path construction, credential loading, teardown, caching, a frontmatter split re-rolled as a regex beside the production splitter.
- An expected answer is computed by copying the algorithm under test, or by calling it. Either way the test derives its expectation from the code it judges and can only agree with it.
- A fake enforces the policy of the system it replaces — authorization rules, scheduling decisions, validation, invented restrictions. A second test comparing the fake with the real system does not pay for two implementations.
- A stand-in host runs production functions in a composition production never uses and claims to verify that path — a browser component executed through a server-side module loader. Calling real functions is not enough when the host, runtime, or orchestration is the behavior under test.
- A reuse refactor production does not itself call: production stays on its old path while the test uses the new one, or the new parameter or branch is turned only by tests. Shared means production calls it.

## Do NOT flag

- A unit test driving a function's public arguments and asserting its return. Exercising a real unit does not require reproducing the application around it.
- A literal that pins a contract, or a property that asserts a stated invariant. A test must know the promise it asserts; it must not implement the mechanism that produces the answer.
- Setup that calls production helpers, or a refactor that gives production and a real test consumer one implementation. A test is a second consumer that exists now, not premature DRY (`no-speculative-machinery`).
- Scripted returns, call recording, or replay that adds none of the replaced system's policy. Whether such a double belongs there, and what its assertions may read, is `tests-pin-behavior` and AGENTS.md.
- Missing coverage, including a case dropped because reaching it required a parallel implementation. This check judges how added or changed tests reach production; it never demands new tests, generators, or harnesses, and never sweeps untouched suites.

## Calibration

> "one problem we've seen repeatedly now in tests is that codex/claude will build parallel implementations for testing purposes. i would MUCH RATHER cut scope on test coverage than build parallel implementations to test out small edge-cases. in order for tests to be truly effective and to be cheap, they should be re-using logic from production. that makes production better."

> "ideally we're re-suing production logic as much as possible, or refactoring the logic so that we can use it for production and test."
