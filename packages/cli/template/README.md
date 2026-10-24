# Your ContextLayer slate

This slate contains an interactive React Router app, uses ContextLayer for connected services, and is deployed through its Git remote.

See ContextLayer's [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) for declarations, resources, Owners, and assignments.

## Develop locally

From the checkout root, run:

```sh
pnpm dev
```

Open the local URL printed by the development server. Edit `app/routes/home.tsx` to build your first page. Use `pnpm typecheck` and `pnpm build` for the checkout's normal TypeScript and production-build commands.

## Use connected services

Declare the connections your app needs in `public/slate.json`. Connect an account to ContextLayer in your browser, then assign the connected account to one of your app's declared connections. An already connected account can go directly to assignment. Command help supplies the supported operations:

```sh
npx @usecontextlayer/cli accounts --help
npx @usecontextlayer/cli connections --help
```

The installed SDK guide at `node_modules/@usecontextlayer/sdk/README.md` gives the complete Gmail sequence: copy its route and declaration, connect a Gmail account when needed, assign it to `work-email`, and start development. Local assignments are saved in ignored `.contextlayer/connections.json`. Restart `pnpm dev` after changing declarations or local assignments.

## Store slate data

Declare database slugs in `public/slate.json` or `agents/<name>/slate.json`, following the [resource invariants](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles). Local development persists SQLite state in ignored `.contextlayer/databases`.

The starter contains no example database. Create each database’s Drizzle configuration, query schema and migrations under `databases/<slug>`. Run `pnpm db:migration --config databases/<slug>/drizzle.config.ts --name <change>`, then write the blank SQL migration explicitly and update the query schema. Commit the SQL and native journal together. The query schema supplies types and does not generate the deployed database schema. The installed SDK guide documents `databasesContext` and the native Drizzle query client.

Restart local development after adding a migration. Push committed migrations to `main` for hosted provisioning; see [database ownership and provisioning](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-databases-and-authored-migrations) for its lifecycle. Use `database_query` for persistent agent data.

## Deploy

Initialization commits the complete starter on `main`. Push it with `git push -u origin main`. After editing the app, commit your changes before pushing:

```sh
git add .
git commit
git push -u origin main
```

ContextLayer builds and deploys the slate through its native Git remote. Your dashboard and hosted URL were printed by initialization. The hosted URL becomes usable after deployment succeeds. The slate starts private; sign in with your ContextLayer account to open it. Configure hosted assignments in the header of the [chrome](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-chrome).
