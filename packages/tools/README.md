# @usecontextlayer/tools

Tools for ContextLayer React Router apps. In local development, calls execute through the ContextLayer platform using your assigned Composio Platform connections.

Create an app with `npx @usecontextlayer/cli init my-app`. The CLI installs this package and configures a development-only Cloudflare Worker and native service binding. Use the generated app's normal `pnpm dev` command. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated projects.

## Local login and assignment

Run `ctx login` to save your ContextLayer login. Declare `work-email` as an individual Gmail requirement in `public/slate.json`, then use `ctx connections list` to find your connection and `ctx connection local assign work-email <connection_id>` to assign it. Run local commands from the app root.

When `pnpm dev` starts, the generated Vite configuration calls `getLocalToolsBindings` from `@usecontextlayer/cli/vite`. This Node helper reads the AppID from Git origin and obtains a current access token using the same saved login as the CLI. Only the AppID, platform URL, and access token enter the local Tools Worker. The refresh token stays in `~/.contextlayer/auth.json`; the Composio project key stays on the platform. Restart `pnpm dev` when the access token expires.

## A loader that reads Gmail

The first argument is the connection requirement slug in `public/slate.json`, such as `work-email`. The platform resolves it using the app and signed-in user:

```ts
import { toolsContext } from "@usecontextlayer/tools"
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

The package root exports the `Tools` interface and `toolsContext`. `@usecontextlayer/tools/local` exports the local `Tools` Worker entrypoint. The CLI package owns the Node startup helper and saved-login handling. The generated application owns its thin Worker entrypoints and Vite configuration. The Cloudflare Vite plugin runs the auxiliary Worker only in development; production bundles exclude it and its service binding.

The platform execution API is implemented; deployed viewer integration is not yet implemented. The generated entrypoint reserves `ctx.props.tools` for that later path. Local access-token bindings are not included in production builds.
