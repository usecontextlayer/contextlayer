# ContextLayer slate

Follow ContextLayer's [domain model and resource invariants](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model). Put the app's declaration in `public/slate.json`, agent declarations in `agents/<name>/slate.json`, and MCP declarations in `mcp/<name>/slate.json`. Declare each resource in every consumer that needs it. All declarations share one namespace: matching database slugs select the same database, and repeated declarations must agree on owner/viewer mode. Connections and secrets follow the same namespace rule. MCP declaration resource collections must currently be empty because MCP resource execution is not implemented.

## Databases and migrations

Keep persistent slate data in declared SQLite databases and treat agent filesystem files as scratch data. Keep each database's Drizzle configuration, query schema, and migration history under `databases/<slug>`. The `updates` directory is an example; declare it where needed or create the corresponding directory for another database.

Write SQL migrations explicitly, following the [README workflow](README.md#store-slate-data). Separate statements with Drizzle's `--> statement-breakpoint` marker. Commit the SQL and generated metadata together. Never generate migrations from schema changes, run `drizzle-kit push`, or change deployed schemas ad hoc. Update `schema.ts` for typed queries alongside the SQL; the schema does not create tables.

Preserve platform's [database ownership and provisioning boundary](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-databases-and-authored-migrations). Authored code names declared slugs; leave physical instances and credentials to ContextLayer.

Use `databasesContext` from `@usecontextlayer/sdk` in loaders and actions, and `database_query` in agents. Import the query schema through the checkout's `@/databases` alias. The [SDK guide](https://www.npmjs.com/package/@usecontextlayer/sdk) documents the Drizzle and direct SQL APIs.
