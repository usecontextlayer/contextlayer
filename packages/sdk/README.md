# @usecontextlayer/sdk

ContextLayer integration for React Router apps: the shared document Layout and Tools/Viewer capabilities. In local development, tool calls execute through the ContextLayer platform using the manifest-selected viewer or app Owner's assigned Composio Platform connections.

Create an app with `npx @usecontextlayer/cli init my-app`. The CLI installs this package and configures a development-only Cloudflare Worker and native service binding. Use the generated app's normal `pnpm dev` command. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated projects.

## Local login and assignment

Run `ctx login` to save your ContextLayer login. Declare `work-email` as a viewer-mode Gmail requirement in `public/slate.json`, then use `ctx connections list` to find your connection and `ctx connection local assign work-email <connection_id>` to assign it. Run local commands from the app root.

For an organization-owned app's owner-mode requirement, authorize and list the account under the organization before assigning it. The connection commands' `--help` owns organization selection. The member completes OAuth for that Owner, and the platform uses the same organization's Composio identity when executing the requirement.

When `pnpm dev` starts, `contextlayer(env)` from `@usecontextlayer/sdk/vite` configures the Cloudflare Vite plugin and calls the CLI-owned `getLocalToolsBindings` helper. This Node helper reads the AppID from Git origin, validates `public/slate.json`, and obtains a current access token using the same saved login as the CLI. The AppID, platform URL, auth issuer, access token, and manifest startup snapshot enter the existing local auxiliary Worker, which exports Tools and Viewer entrypoints. The refresh token stays in `~/.contextlayer/auth.json`; the Composio project key stays on the platform. Restart `pnpm dev` when the access token expires or the manifest changes.

## App Layout

The generated `app/root.tsx` re-exports the SDK's document Layout and root loader:

```tsx
export { Layout, loader } from "@usecontextlayer/sdk/react"
```

The Layout owns the HTML document, React Router's metadata, links, scripts, scroll restoration, and the shared ContextLayer header. The app owns its routes, root component, error boundary, stylesheet, and font links. The thin, full-width header expands an inline settings panel, moving the app content down. Connection controls are not implemented yet.

The header and settings panel render into a native ShadowRoot through a React portal after hydration. Vite processes `@usecontextlayer/sdk/styles.css?inline` into a stylesheet string, which is inserted only into that ShadowRoot; apps must not import the SDK stylesheet globally. The shadcn Base UI Collapsible owns the single header trigger, open state, accessibility, and panel lifecycle; its content remains in normal document flow. The lowercase wordmark uses the existing Fugaz One font through the browser's Font Loading API. The app's Tailwind and shadcn base-nova configuration are independent of these chrome styles. Chrome rendering lives in the SDK rather than being copied into each app or injected into HTML by the dispatcher.

## A loader that reads Gmail

The first argument is the connection requirement slug in `public/slate.json`, such as `work-email`. Its manifest mode selects the acting user's assignment (`viewer`) or the app's owning user or organization's assignment (`owner`):

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

## Current viewer

Read the safe profile in a loader through the request-scoped Viewer capability:

```ts
import { viewerContext } from "@usecontextlayer/sdk"
import type { LoaderFunctionArgs } from "react-router"

export async function loader({ context }: LoaderFunctionArgs) {
  return context.get(viewerContext).getCurrentUser()
}
```

The result is `{ id, name, image }` with nullable image, or `null` for an anonymous viewer. Local Viewer sends the saved CLI access token directly to web's `/api/me`; hosted Viewer sends the existing viewer cookie to that same endpoint. `CTX_AUTH_ISSUER` determines web's origin. Web verifies identity; the capability validates its response with Zod. The app receives only profile data through RPC. No access token, session cookie, refresh token, or platform profile proxy is exposed. The SDK root loader reads this profile once and Layout consumes the root route data to show the avatar and name in the always-visible header. Anonymous viewers see “Not signed in”. The installed local loader has been verified through the native development Worker. Hosted WfP verification remains pending.

## Runtime ownership

The package root exports the `Tools` and `Viewer` interfaces, `User` profile type, and `toolsContext`/`viewerContext`. `@usecontextlayer/sdk/react` exports the shared React Router document `Layout` and profile `loader`; `@usecontextlayer/sdk/styles.css` exports the chrome stylesheet for Vite to process and render inside the ShadowRoot. `@usecontextlayer/sdk/local` exports the local `Tools` and `Viewer` Worker entrypoints. `@usecontextlayer/sdk/worker` exports `createApp`, which creates the React Router request handler and supplies `toolsContext` and `viewerContext` from local bindings or production request props. The native default `viewerContext` returns null for anonymous viewers. `@usecontextlayer/sdk/vite` owns the `contextlayer` integration. The CLI package owns the Node startup helper and saved-login handling. The generated application supplies its virtual server-build import, mode, and development flag through thin Worker wiring, and composes Vite plugins. The Cloudflare Vite plugin runs the auxiliary Worker only in development; production bundles exclude it and its service binding.

In hosted apps, the dispatcher supplies `ctx.props.tools` as a request-scoped RPC handle. Its methods call the same platform execution API using the viewer session; the app cannot read the underlying viewer credential. That session authenticates the caller, while the deployed manifest's mode selects the viewer or app Owner's assignment for the app and slug. For viewer-mode requirements, a viewer using the same account as the CLI uses the same saved assignment. Owner-mode requirements use the app Owner's configured account. Local access-token bindings are not included in production builds.

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

This integration supplies the Cloudflare plugin; do not add a second instance. It uses the generated `workers/local-tools/wrangler.jsonc` to start the local Tools Worker and provides its development-only Tools and Viewer service bindings. At development startup, the CLI reads the app's Git origin, saved ContextLayer login, and validated manifest snapshot. The restart prerequisites are described under [Local login and assignment](#local-login-and-assignment). Production builds exclude local credentials and the auxiliary Worker.

The app retains its routes, `public/slate.json`, and thin Worker/configuration files. `@usecontextlayer/sdk/worker` owns the React Router request handler and Tools/Viewer context setup.
