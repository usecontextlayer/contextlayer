# contextlayer-seams

The contextlayer monorepo's layer contracts hold — each package does exactly its job, and domain logic stays in its owning layer. (Applies only to the contextlayer monorepo; if the code under review is not that repo, report no findings and say why.)

These are earned, standing seam contracts; a change that crosses one FAILs. Use the canonical vocabulary in [ARCHITECTURE.md](../../ARCHITECTURE.md#domain-model).

## The contracts

- **Platform domain functions own product operations.** API handlers and React Router server loaders/actions validate boundary inputs and call the same domain function for business rules, authorization, and database access. HTTP and framework response adaptation stay at the entry points; the domain function receives typed arguments and returns typed results.
- **Presentation reads no source files and derives no domain facts.** UI components consume the rich results of domain operations and own rendering and interaction. Source I/O, raw-content parsing, and business decisions stay in their owning server or local-tooling modules.
- **Generic infrastructure is domain-agnostic.** ContextLayer must not hardcode an authored slate's business types, fields, or schemas into generic infrastructure. Receive that domain as authored data or delegate to an explicitly owned domain module.
- **Declaration reads and resource selection have separate owners.** Platform's shared declaration reader owns the coherent pushed snapshot of the slate's app and agent declarations; local tooling owns checkout declaration and configuration I/O. Shared resource collection and consumer selection remain pure. Runtime consumers receive prepared inputs rather than rereading source files or independently resolving configuration. Authored MCP declarations follow the SDK build and dispatcher validation boundary described in ARCHITECTURE.md.
- **Authored resource declarations are explicit contracts.** Parse them through the shared strict Zod schema at their source boundary, and use shared collection and consumer selection for the slate's app and agent resources. Keep connected-account assignments, physical database references, and secret values out of authored requirements.
- **Runtime boundaries follow exported subpaths.** Browser entry points and their transitive runtime imports must remain browser-compatible; Node tooling and Worker capabilities stay behind their designated exports. A package with browser exports must not route those exports through its Node-only or Worker-only modules.

## Do NOT flag

- Domain content inside authored files, or domain logic in an explicitly owned domain module — the violation is leakage into layers meant to be generic. ContextLayer's own slate, app, agent, MCP, and resource contracts are legitimate platform concepts.
- React Router server loaders/actions calling shared domain operations, or UI formatting and layout calculations — neither moves business logic into presentation.
- Node imports in the CLI or SDK Vite tooling, or Worker imports in Worker exports — inspect the runtime import graph of the affected export, not the package name alone.
