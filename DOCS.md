# Documentation

Each document has a distinct purpose. Keep information with the document that owns it.

- **ARCHITECTURE.md:** system ownership, dataflow, trust boundaries, stable relationships, and architectural invariants. Explain the concepts and why the boundaries matter. Security guidance should express principles and requirements the system must uphold.
- **AGENTS.md:** construction principles and rules for future changes. Root guidance applies across the repository; package guidance adds domain-specific constraints. Preserve conceptual integrity, consistent patterns, and the intended layering.
- **DEVELOPING.md:** setup, commands, prerequisites, local development, testing, migrations, and operational workflows. Include the instructions and constraints needed to work on the system.
- **ExecPlans:** implementation decisions, slice progress, verification evidence, temporary limitations, and remaining work. Keep detailed implementation and session history here.

Keeping documentation current means correcting an affected concept, principle, contract, or workflow in its owning document. A feature change does not automatically require edits to every document. Exact UI copy, icon colors, component wiring, callback mechanics, and per-slice status belong in code or the relevant ExecPlan. Promote a decision into the lasting docs when it establishes a durable invariant or development requirement, rather than copying the implementation narrative across them.
