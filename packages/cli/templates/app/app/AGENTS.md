# ContextLayer slate

Follow ContextLayer's [domain model and resource invariants](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model). Put the app's declaration in `app/slate.json`, agent declarations in `agents/<name>/slate.json`, and MCP declarations in `mcp/<name>/slate.json`. Declare each resource in every consumer that needs it. All declarations share one namespace: matching database slugs select the same database, and repeated declarations must agree on owner/viewer mode. Connections and secrets follow the same namespace rule. MCP declaration resource collections must currently be empty because MCP resource execution is not implemented.

## Databases and migrations

Keep persistent slate data in declared SQLite databases and treat agent filesystem files as scratch data. Keep each database's native Kysely config, migrations, and generated query types under `databases/<slug>`. The starter declares an owner-mode `notes` database used by its route loader and action.

Author migrations explicitly with the native Kysely CLI, following the [README workflow](../README.md#store-slate-data). Kysely owns migration naming, ordering, and applied history. Apply migrations to the running local database, then run `pnpm db.codegen <slug>` to derive its query types. Commit migrations and generated `types.ts` together; never hand-edit generated types or infer schema changes from them. Migration and type generation are separate operations.

Preserve platform's [database ownership and provisioning boundary](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-databases-and-authored-migrations). Authored code names declared slugs; leave physical instances and credentials to ContextLayer. Local tools access only local storage. Push runs migrations in the isolated build pipeline before deployment; new members start a background Workflow that uses the same native CLI and then provisions schedules. Membership is established before that work finishes. A failure stops provisioning or deployment, and successful SQL statements may already have been applied.

Use `database<DB>(context.get(databasesContext), "notes")` from `@usecontextlayer/sdk` in loaders and actions, importing generated `DB` through `@/databases/notes/types`. Use native Kysely queries and `.returning()` for mutation results. Hosted agents continue using `database_query`. The [SDK guide](https://www.npmjs.com/package/@usecontextlayer/sdk) documents the typed and direct SQL APIs.
