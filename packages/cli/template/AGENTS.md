# ContextLayer app

The interactive app declares resources in public/slate.json. Each agent declares its resources in agents/<name>/slate.json. All declarations share one namespace: matching database slugs select the same database, and repeated declarations must agree on owner/viewer mode. Connections and secrets follow the same namespace rule.

## Databases and migrations

Persistent app data belongs in declared SQLite databases. Each database keeps its Drizzle configuration, query schema and migration history under databases/<name>. The updates directory is an example; declare it in the relevant Slates to use it, or create the corresponding directory for your own database.

Write SQL migrations explicitly. Run pnpm db:migration --config databases/<name>/drizzle.config.ts --name <change> to scaffold a blank migration with Drizzle Kit's native metadata, then author its SQL. Separate statements with Drizzle's --> statement-breakpoint marker. Commit the SQL and generated metadata. Never generate migrations from schema changes, run drizzle-kit push, or change deployed schemas ad hoc. Update schema.ts for typed queries alongside the SQL; the schema does not create tables.

Platform applies pending migrations when publishing the app and when a member joins. Local Vite startup applies current-checkout migrations to ignored .contextlayer/databases before the app runs. Local agents use that same native local storage. Owner/viewer modes select hosted ownership; both use developer-local storage during development. No database selector or assignment is needed.

Loaders and actions receive the request-scoped databasesContext from @usecontextlayer/sdk. Use database(context.get(databasesContext), "updates", schema) for native Drizzle queries, or call the capability's query(slug, sql, params) for SQL. Import the query schema through the app’s @/databases alias. Authored code selects declared slugs; platform owns physical instances and credentials. Agent database_query writes persist immediately. Sandbox files are scratch data.
