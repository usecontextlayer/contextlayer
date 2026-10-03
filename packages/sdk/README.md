# @usecontextlayer/sdk

Tools for ContextLayer React Router apps. In local development, calls execute through the ContextLayer platform using your assigned Composio Platform connections.

Create an app with `npx @usecontextlayer/cli init my-app`. The CLI installs this package and configures a development-only Cloudflare Worker and native service binding. Use the generated app's normal `pnpm dev` command. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated projects.

## Local login and assignment

Run `ctx login` to save your ContextLayer login. Declare `work-email` as an individual Gmail requirement in `public/slate.json`, then use `ctx connections list` to find your connection and `ctx connection local assign work-email <connection_id>` to assign it. Run local commands from the app root.

When `pnpm dev` starts, `contextlayer(env)` from `@usecontextlayer/sdk/vite` configures the Cloudflare Vite plugin and calls the CLI-owned `getLocalToolsBindings` helper. This Node helper reads the AppID from Git origin and obtains a current access token using the same saved login as the CLI. Only the AppID, platform URL, and access token enter the local Tools Worker. The refresh token stays in `~/.contextlayer/auth.json`; the Composio project key stays on the platform. Restart `pnpm dev` when the access token expires.

## A loader that reads Gmail

The first argument is the connection requirement slug in `public/slate.json`, such as `work-email`. The platform resolves it using the app and signed-in user:

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

Calls return `{ data, logId }`. Validate the tool-specific `data` in your loader. The complete [Gmail example](examples/gmail.tsx) validates the response with Zod and renders a message list. Copy it to `app/routes/home.tsx` in a generated app and assign your Gmail connection to `work-email`.

## Runtime ownership

The package root exports the `Tools` interface and `toolsContext`. `@usecontextlayer/sdk/local` exports the local `Tools` Worker entrypoint. `@usecontextlayer/sdk/worker` exports `createApp`, which creates the React Router request handler and supplies `toolsContext` from the local binding or production request props. `@usecontextlayer/sdk/vite` owns the `contextlayer` integration. The CLI package owns the Node startup helper and saved-login handling. The generated application supplies its virtual server-build import, mode, and development flag through thin Worker wiring, and composes Vite plugins. The Cloudflare Vite plugin runs the auxiliary Worker only in development; production bundles exclude it and its service binding.

In hosted apps, the dispatcher supplies `ctx.props.tools` as a request-scoped RPC handle. Its methods call the same platform execution API using the viewer session; the app cannot read the underlying viewer credential. The platform resolves the signed-in viewer’s assignment for the app and slug, so a viewer using the same account as the CLI uses the same saved assignment. Local access-token bindings are not included in production builds.

## Vite configuration

ContextLayer's Vite integration for Cloudflare React Router apps. Compose it with the app's React Router and Tailwind plugins:

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

This integration supplies the Cloudflare plugin; do not add a second instance. It uses the generated `workers/local-tools/wrangler.jsonc` to start the local Tools Worker and provides its development-only service binding. At development startup, the CLI reads the app's Git origin and saved ContextLayer login. Production builds exclude local credentials and the auxiliary Worker.

The app retains its routes, `public/slate.json`, and thin Worker/configuration files. `@usecontextlayer/sdk/worker` owns the React Router request handler and Tools context setup.
