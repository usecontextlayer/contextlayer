# Your ContextLayer slate

This slate contains an interactive React Router app, uses ContextLayer for connected services, and is deployed through its Git remote.

See ContextLayer's [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) for declarations, resources, Owners, and assignments.

## Develop locally

From the checkout root, run:

```sh
pnpm dev
```

This invokes `ctx dev`: the CLI starts trusted local resources, applies pending migrations, then starts the authored Vite app. Open the local URL printed by the development server and add a note. The starter reads and writes its declared `notes` database. Edit `app/routes/home.tsx` to build your first page. Use `pnpm typecheck` and `pnpm build` for the checkout's normal TypeScript and production-build commands.

## Use connected services

Declare the connections your app needs in `app/slate.json`. Connect an account to ContextLayer in your browser, then assign the connected account to one of your app's declared connections. An already connected account can go directly to assignment. Command help supplies the supported operations:

```sh
npx @usecontextlayer/cli accounts --help
npx @usecontextlayer/cli connections --help
```

Local assignments are saved in ignored `.contextlayer/connections.json`. Supply declared secrets through the startup process environment. Assigned connections use the saved developer login and registered slate; local databases and environment-only agents need neither. Restart `pnpm dev` after changing instructions, declarations, schedules, environment values or local assignments. Add agents under `agents/<name>` and declare shared database slugs in each consumer; they run through the same native stack and use this app's database. Docker is required when agents are present. `ctx dev` also runs in checkouts without an app or package manifest.

## Store slate data

Declare database slugs in `app/slate.json` or `agents/<name>/slate.json`, following the [resource invariants](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles). Local development persists SQLite state in ignored `.contextlayer/databases`.

The starter's shared `notes` database has a native `databases/notes/kysely.config.ts`, explicitly authored migrations, and generated `types.ts`. Local startup applies the local checkout’s pending migrations before the app can query. To change the schema while development is running:

```sh
pnpm exec kysely --config databases/notes/kysely.config.ts migrate make add_created_at
```

Edit the generated migration's `up(db)` (and optional `down(db)`) using native Kysely schema operations or `sql`. Then apply it and generate the query types separately:

```sh
pnpm exec kysely --config databases/notes/kysely.config.ts migrate latest
pnpm db.codegen notes
```

Commit migrations and generated `databases/notes/types.ts` together. The types come from the migrated local database; do not edit them by hand. Keep the development server running for migration and codegen commands. `pnpm exec kysely --help` provides the native migration and seed operations. For another declared database, give it its own config and migration directory, then select its slug with codegen.

The route uses `database<DB>(context.get(databasesContext), "notes")` from the SDK for typed queries. Mutations return Kysely's affected-row counts and SQLite insert IDs; use `.returning()` to read inserted or updated rows instead. Direct SQL and agents' `database_query` use the same storage.

Push committed changes to `main` for hosted provisioning. The pipeline builds the commit, runs its native Kysely migrations, then deploys it. New membership starts a background Workflow that initializes personal databases and then provisions schedules; requests continue while that work runs. Migration failure blocks deployment or provisioning; earlier successful SQL statements can remain applied. See [database ownership and provisioning](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-databases-and-authored-migrations) for its lifecycle.

## Deploy

Initialization commits the complete starter on `main`. Push it with `git push -u origin main`. After editing the app, commit your changes before pushing:

```sh
git add .
git commit
git push -u origin main
```

ContextLayer builds and deploys the slate through its native Git remote. Your dashboard and hosted URL were printed by initialization. The hosted URL becomes usable after deployment succeeds. The slate starts private; sign in with your ContextLayer account to open it. Configure hosted assignments in the header of the [chrome](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-chrome).

After pushing, inspect CI and the published Worker using your normal ContextLayer login. Use CLI help for the entry points and the [deployment guide](https://docs.usecontextlayer.com/how-to/deploy) to interpret the results.
