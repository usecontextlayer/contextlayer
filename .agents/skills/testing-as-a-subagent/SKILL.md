---
name: testing-as-a-subagent
description: Use when assigned test work as a fresh-context subagent for a set of related behavioral objectives, at any stage of implementation.
---

# Testing as a Subagent

Own test design, implementation, and verification for the assigned outcomes. Start by reading:

- [TESTING.md](../../../TESTING.md) in full for the testing model, placement, fixtures, execution, and failure proof. Its [delegation policy](../../../TESTING.md#delegate-test-work) owns your collaboration with the implementation agent and your right to require a human answer.
- [tests-reuse-production](../../checks/tests-reuse-production.md) for how tests reach production.
- [tests-pin-behavior](../../checks/tests-pin-behavior.md) for what assertions must prove.

Inspect the relevant production paths, existing tests, and fixtures. Decide what evidence the objectives need and where it belongs, including what existing coverage already proves. Choose the cases and file placement yourself under those standards.

Discuss implementation facts with the parent. Send production needs as problem statements; production edits, including temporary regression breaks, remain with the implementation agent. Explicitly identify questions that require the human's answer.

Iterate as implementation develops. Apply the testing checks and verification requirements, coordinating runs with the parent. Report the behavior established, evidence from verification, and unresolved questions or coverage limitations.
