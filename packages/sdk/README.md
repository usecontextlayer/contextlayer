# @usecontextlayer/sdk

ContextLayer integration for slates: the app's shared document Layout, a Worker serving app routes and MCP tools, and Tools and Databases capabilities. The [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) defines slates, declarations, resources, Owners, and assignments.

Use Node.js 24 or newer, pnpm, and Git with configured author identity. Start with login, then create and run your slate:

```sh
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-slate
cd my-slate
pnpm dev
```

The CLI installs this package and configures local development. Open the local URL printed by the development server. Initialization prints your dashboard link, hosted URL, and Git deployment steps; the hosted URL becomes usable after deployment succeeds. Use `npx @usecontextlayer/cli` for subsequent CLI commands. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated checkouts.

## Local login and assignment

Declare resources in `public/slate.json` and `agents/<name>/slate.json`, following the [resource invariants](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles). Use `npx @usecontextlayer/cli connections --help` and `npx @usecontextlayer/cli connection --help` for listing, connecting personal accounts, and assignment syntax. Local assignments are saved in ignored `.contextlayer/connections.json`.

For local tool calls, assign your personal connected accounts even when the hosted declaration uses `owner` mode or the slate belongs to an organization. Keep `.contextlayer/` ignored in Git. Local database state lives in `.contextlayer/databases`; local secret values come from environment variables with their declared names.

When the app declares connections, Vite startup needs a matching CLI login and the generated Git origin to identify the slate. This also applies when running a local agent because that command starts Vite. Restart `pnpm dev` after changing declarations, assignments, secret values, or migrations, and when the startup access token expires. The [local resource architecture](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles) describes preparation and credential boundaries.

## App Layout

The generated `app/root.tsx` re-exports the SDK's document Layout:

```tsx
export { Layout } from "@usecontextlayer/sdk/react"
```

Keep this re-export when editing the app's root component, error boundary, stylesheet, and font links. Layout supplies React Router's document elements and mounts the [chrome](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-chrome) outside Vite development. Use the chrome's header to configure hosted connections, then refresh the page. Use CLI assignments during local development.

## Standalone HTML pages

Use `htmlPage` for a complete server-rendered document with a centered, responsive white card. It loads pinned Bootstrap 6 CSS through a CDN stylesheet link and uses Bootstrap classes for layout. Supply the card's contents with Hono's `html` helper and standard Bootstrap markup; no React, custom CSS or frontend build configuration is required.

```ts
import { htmlPage } from "@usecontextlayer/sdk/html"
import { html } from "hono/html"

return c.html(htmlPage({
  title: "Connect your account",
  children: html`<h1 class="h4">Connect your account</h1>
    <form action="/authorize" method="get">
      <!-- Application-owned fields and authorization parameters -->
      <button class="btn-solid theme-inverse" type="submit">Continue</button>
    </form>`,
}))
```

The caller owns the content, form destination, validation and authorization flow. The helper supplies only the document and presentation shell.

## A loader that reads Gmail

Pass the connection slug from `public/slate.json` as the first argument to `tools.call`, followed by the tool name and its arguments:

```ts
import { toolsContext } from "@usecontextlayer/sdk"
import type { LoaderFunctionArgs } from "react-router"

export async function loader({ context }: LoaderFunctionArgs) {
  return context.get(toolsContext).call("work-email", "GMAIL_FETCH_EMAILS", {
    max_results: 5,
    label_ids: ["INBOX"],
    include_payload: false,
    verbose: false,
  })
}
```

Calls return `{ data, logId }`. Validate the tool-specific `data` in your loader. The [Gmail route](examples/gmail/app/routes/home.tsx) validates the response with Zod and renders a message list. Its [declaration](examples/gmail/public/slate.json) declares `work-email` as viewer-mode Gmail. The example follows the same `app/routes/home.tsx` and `public/slate.json` layout as your checkout.

From a newly generated checkout's root, copy both files from the installed SDK:

```sh
cp node_modules/@usecontextlayer/sdk/examples/gmail/app/routes/home.tsx app/routes/home.tsx
cp node_modules/@usecontextlayer/sdk/examples/gmail/public/slate.json public/slate.json
```

If you have no connected Gmail account yet, connect one:

```sh
npx @usecontextlayer/cli connections add gmail
```

Open the printed link to connect your Gmail account in your browser. Next, assign the connected account to this slate's `work-email` connection, then start development. If your Gmail account is already connected, begin with assignment:

```sh
npx @usecontextlayer/cli connection local assign work-email
pnpm dev
```

Open the local URL printed by the development server to see your inbox. If development is already running, restart it after copying the declaration and assigning the connected account so startup reads the new configuration.

If the declared connection has no assignment yet, the generated app's error boundary shows guidance for the unassigned connection. Locally, follow its assignment command and restart `pnpm dev`. In a hosted slate, open the connections menu in the chrome's header, assign a connected account, and refresh the page. Join the slate before executing a viewer-mode resource; see [membership and provisioning](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-forking-membership-and-resource-ownership).

## Handling tool errors

For a custom error boundary, use React Router's `isRouteErrorResponse(error)` and the SDK's `connectionRequiredSchema.safeParse(error.data)` to recognize the HTTP 409 payload `{ reason: "connection-required", slug }`. The generated root already handles this response. See the [execution boundary](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles) for authorization and credential handling.

## Vite and Worker configuration

Compose `contextlayer` with the app's React Router and Tailwind plugins:

```ts
import { contextlayer } from "@usecontextlayer/sdk/vite"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig((env) => ({
  plugins: [contextlayer(env), tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
}))
```

This integration supplies the Cloudflare plugin; do not add a second instance. Keep the generated `workers/local-resources/wrangler.jsonc` and `workers/local-resources/index.ts` for local development. Follow the [startup and restart prerequisites](#local-login-and-assignment) when changing resources.

Keep the generated `workers/app.ts` wiring to `createSlateWorker` from `@usecontextlayer/sdk/worker`. It supplies the virtual React Router server build, Vite mode and development flag, and authored MCP modules. `createSlateWorker` returns the exported `SlateWorker` type. The [runtime architecture](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles) owns capability wiring and trust boundaries.

## A loader that queries cached data

Declare a database slug in `public/slate.json` and the same slug in `agents/<name>/slate.json` when both should share data, following the [resource invariants](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#resource-configuration-and-execution--principles). Store its authored SQL migrations under `databases/<slug>/migrations`. The template supplies Drizzle configuration and query schema; `pnpm db:migration --config databases/<slug>/drizzle.config.ts --name <change>` scaffolds a blank migration for you to write explicitly. Commit the SQL and native `meta/_journal.json` together. Update the TypeScript schema for query types alongside the migration; it does not create tables.

```ts
import { database, databasesContext } from "@usecontextlayer/sdk"
import { eq } from "drizzle-orm"
import type { LoaderFunctionArgs } from "react-router"
import * as schema from "@/databases/updates/schema"

export async function loader({ context }: LoaderFunctionArgs) {
  const db = database(context.get(databasesContext), "updates", schema)
  return db.select().from(schema.updates).where(eq(schema.updates.kind, "email"))
}
```

For direct SQL, use `context.get(databasesContext).query("updates", sql, params)`. Agents use `database_query` for persistent data. Restart local development after adding migrations, and push committed migrations to `main` for hosted provisioning. See [database ownership and provisioning](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-databases-and-authored-migrations) for the lifecycle and isolation rules.
