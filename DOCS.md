# Documentation

Each document has a distinct purpose. Keep information with the document that owns it.

- **ARCHITECTURE.md:** system ownership, dataflow, domain terminology, domain concepts, trust boundaries, stable relationships, security guidance, principles, and architectural invariants. Explain the concepts and why the boundaries matter. Describes in should/must what the system must uphold. This is the key document that upholds and propagates conceptual integrity. The [domain model](ARCHITECTURE.md#domain-model) owns the slate vocabulary; other documents link to it instead of redefining it:
    - https://wiki.c2.com/?ConceptualIntegrity
    - https://wiki.c2.com/?ArchitectAsKeeperOfTheFlame
- **AGENTS.md:** construction principles and rules for future changes. Root guidance applies across the repository; preserves consistent patterns, and the intended layering.
- **DEVELOPING.md:** setup, commands, prerequisites, local development, testing, migrations, and operational workflows. Include the instructions and constraints needed to work on the system.
- **ExecPlans:** implementation decisions, slice progress, verification evidence, temporary limitations, and remaining work. Keep detailed implementation and session history here.

Keeping documentation current means correcting an affected concept, principle, contract, or workflow in its owning document. A feature change does not automatically require edits to every document. Exact UI copy, icon colors, component wiring, callback mechanics, and per-slice status belong in code or the relevant ExecPlan. Promote a decision into the lasting docs when it establishes a durable invariant or development requirement, rather than copying the implementation narrative across them.

Notes that are specific to a package go into that package's AGENTS.md. A package usually has only an AGENTS.md; split it into its own DEVELOPING.md and ARCHITECTURE.md only when that file grows too large. The root ARCHITECTURE.md and DEVELOPING.md files are for repo-wide notes.
