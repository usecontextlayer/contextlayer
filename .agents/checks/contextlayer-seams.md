# contextlayer-seams

The contextlayer monorepo's layer contracts hold — each package does exactly its job, and domain logic stays in its owning layer. (Applies only to the contextlayer monorepo; if the code under review is not that repo, report no findings and say why.)

These are earned, standing seam contracts; a change that crosses one FAILs.

## The contracts

- **Indexes live in the data layer, never client presentation.** The data layer builds indexes from source and runs loaders over them; presentation consumes the results. Transport stays transport — no domain transformation or domain knowledge leaks into it.
- **Presentation reads no files and derives no domain facts.** It consumes rich data the data layer surfaces. File I/O, raw-content parsing, and domain derivation belong to their owning data/model layers.
- **Generic infrastructure is domain-agnostic.** No hardcoded domain type names, field names, or schemas (`type === "Action"`, `fields: ['due','health']`) in modules meant to be generic — receive domain as data or delegate to an explicitly owned domain module.
- **Loaders own facts; synthesizers own judgments.** Ground-truth fields (names, dates, statuses, IDs) are queried from their authoritative data source at load time. Synthesizer prompts/outputs emit judgments, links, and refs only — and refer to types by name, never inline a type definition in their body.
- **Authored vocabularies are explicit contracts.** Directives validate authored args with strict zod schemas actually `.parse()`d at resolve time. A new directive, catalog primitive, or grammar extension is a new capability requiring explicit human sign-off — compose the existing vocabulary; scoping logic belongs in the query/data layer.
- **Isomorphic packages stay isomorphic.** Browser-shippable packages must not gain `node:*` imports or dependencies that drag Node-only globals (Buffer) in transitively.

## Do NOT flag

- Domain content inside content files, or domain logic in an explicitly owned domain module — the violation is leakage into layers meant to be generic.

## Calibration

> "none of this logic should be in bridge. that breaks the invariants"

> "I don't want to encode the idea of Action into the system … i want to try so that slate is _not_ fixed to a particular domain"
