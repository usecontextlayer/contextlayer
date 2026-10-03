# @usecontextlayer/tools

Tools for ContextLayer React Router apps. In local development, calls execute through your personal Composio For You connections.

Create an app with `npx @usecontextlayer/cli init my-app`. The CLI installs this package and configures a development-only Cloudflare Worker and native service binding. Use the generated app's normal `pnpm dev` command. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated projects.

## Local credentials

Connect your account in Composio For You. Copy `workers/local-tools/.dev.vars.example` to `workers/local-tools/.dev.vars` and set `COMPOSIO_CONSUMER_KEY` to your For You consumer key. The generated project's Git rules ignore this file. Each developer uses their own key and connections.

## A loader that reads Gmail

The first argument is **Composio's account alias**, forwarded unchanged as `account`. It is not a ContextLayer connection name. For example, `learnwithcarl.com` is an alias for a connected Gmail account:

```ts
import { toolsContext } from "@usecontextlayer/tools"
import type { LoaderFunctionArgs } from "react-router"

export async function loader({ context }: LoaderFunctionArgs) {
  return context.get(toolsContext).call("learnwithcarl.com", "GMAIL_FETCH_EMAILS", {
    max_results: 5,
    label_ids: ["INBOX"],
    include_payload: false,
    verbose: false,
  })
}
```

Calls return `{ data, logId }`. Validate the tool-specific `data` in your loader. The complete [Gmail example](examples/gmail.tsx) validates the response with Zod and renders a message list. Copy it to `app/routes/home.tsx` in a generated app and use an account alias from your own Composio connections.

## Runtime ownership

The package root exports the `Tools` interface and `toolsContext`. `@usecontextlayer/tools/local` exports the local `Tools` Worker entrypoint. The generated application owns its thin Worker entrypoints and Vite configuration. The Cloudflare Vite plugin runs the auxiliary Worker only in development; production bundles exclude it and its service binding.

Hosted tool execution is not implemented yet. The generated entrypoint reserves `ctx.props.tools` for that later path; the local For You credential is not deployed.
