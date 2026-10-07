# @usecontextlayer/sdk

ContextLayer integration for React Router apps: the shared document Layout and Tools capability. Local tool calls use the signed-in developer's personal accounts and current-folder connection bindings. Hosted calls use pushed requirements and platform-stored viewer/app-Owner assignments.

Create an app with `npx @usecontextlayer/cli init my-app`. The CLI installs this package and configures a development-only Cloudflare Worker and native service binding. Use the generated app's normal `pnpm dev` command. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated projects.

## Local login and assignment

Declare resources in `public/slate.json` and `agents/<name>/slate.json`, using the same Slate schema and shared resource names. Local commands read only the current app folder. Use the connection commands' `--help` for listing, personal account authorization, and assignment syntax. Local listing needs no login or push; choosing an account requires a matching `ctx login`. Account choices are saved in ignored `.contextlayer/connections.json` rather than production assignments.

Local development always uses your personal accounts, including owner-mode requirements in organization-owned apps. Local secrets read environment variables with exactly their declared names; local folders are generated under `.contextlayer/folders/<slug>`. Tooling ignores `.contextlayer/` in Git. Folder construction supplies paths, not an app or agent filesystem capability.

When `pnpm dev` starts, `contextlayer(env)` from `@usecontextlayer/sdk/vite` configures the Cloudflare Vite plugin and calls the CLI-owned `getLocalToolsBindings` helper. This helper assembles the complete current-folder configuration before selecting the app consumer through `resourcesForConsumer`. Only the app's resolved connection entries, the AppID from Git origin, and the CLI access token become trusted native Tools service-binding props. Agent-only connections, secret values, folder paths, and local declarations are not sent to platform or browser code. The AppID supplies app access/subscription/usage context independently of personal credential ownership.

The auxiliary Worker exports the shared `LocalTools` entrypoint as `Tools`. It resolves the requested slug to the startup account ID and declaration toolkit, then calls the personal concrete-account endpoint. Unknown or unassigned local slugs fail locally; there is no production-assignment fallback. The refresh token stays in `~/.contextlayer/auth.json`; the Composio project key stays on platform. Restart `pnpm dev` when the access token expires or declarations/local configuration change.

## App Layout

The generated `app/root.tsx` re-exports the SDK's document Layout:

```tsx
export { Layout } from "@usecontextlayer/sdk/react"
```

The Layout owns the HTML document, React Router's metadata, links, scripts, scroll restoration, and the hosted ContextLayer header. Native Vite development detection disables the header locally, so local configuration never enters the platform frame. The app owns its routes, root component, error boundary, stylesheet, and font links. The thin, full-width header has separate wordmark, connected-services, and viewer sections. The entire connected-services section toggles its inline connection tray, moving the app content down. The wordmark and identity are plain content; anonymous viewers see “Not signed in” without services controls. The tray lists required services and saved accounts, with account controls for Owners the viewer can manage.

The header and tray are served by platform in a cross-origin iframe on slate.usecontextlayer.com. Platform owns their styles, Fugaz One font, and data loading. Layout receives only a height message and resizes the frame to keep the expanding tray in document flow. The app's Tailwind/shadcn setup is independent; there is no SDK stylesheet export or chrome root loader.

An MCP View can mount the same trusted header with an explicit app target, since its host sandbox has a different hostname:

```tsx
import { Chrome } from "@usecontextlayer/sdk/react"

<Chrome target="your-app-id-or-hostname" />
```

The dispatcher declares the platform frame origin through native MCP resource-content CSP metadata. Chrome still reads the app's pushed declarations and uses its own native browser session for account management.

The frame authenticates directly with the native web session. Its cookie always uses Secure, HttpOnly, and SameSite=None, in every environment. When browser third-party-cookie policy permits delivery, the existing web login authenticates the header automatically, without a separate sign-in or frame cookie. Web logout revokes subsequent frame authentication. The surrounding authored page receives neither credentials nor chrome data. Hosted private-app cookie delivery still requires deployed browser verification.

## A loader that reads Gmail

The first argument is the connection requirement slug in `public/slate.json`, such as `work-email`. Locally it selects your saved personal account; in hosted execution the pushed declaration selects the acting user's assignment (`viewer`) or the app's owning user or organization's assignment (`owner`):

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

The package root exports the `Tools` interface and `toolsContext`. `@usecontextlayer/sdk/react` exports the shared document Layout, which mounts platform's chrome iframe only outside development. `@usecontextlayer/sdk/local` bundles the shared `LocalTools` entrypoint and exports it as `Tools`; dispatcher separately exports hosted `Tools`. Both entrypoints share HTTP result/error handling and preserve the authored `tools.call` interface. `@usecontextlayer/sdk/worker` exports `createApp`, which creates the React Router request handler and supplies Tools from local bindings or production request props. `@usecontextlayer/sdk/vite` owns the `contextlayer` integration. The CLI package owns the Node startup helper and saved-login handling. The generated application supplies its virtual server-build import, mode, and development flag through thin Worker wiring. The Cloudflare Vite plugin runs the auxiliary Worker only in development; production bundles exclude it and its service binding. Profile and connection reads belong to the trusted chrome frame; the SDK exposes no Viewer or Connections capability.

In hosted apps, the dispatcher supplies `ctx.props.tools` as a request-scoped RPC handle. Its methods call the hosted slug-based platform execution API using the viewer session; the app cannot read the underlying viewer credential. That session authenticates the caller, while the coherent pushed declaration's mode selects the viewer or app Owner's assignment for the app and slug. Viewer-mode requirements use that viewer's production assignment. Local connection choices remain separate even when the developer is also a production viewer. Owner-mode requirements use the app Owner's configured account. Local access-token bindings are not included in production builds.

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

This integration supplies the Cloudflare plugin; do not add a second instance. It uses the generated `workers/local-tools/wrangler.jsonc` to start the local Tools Worker and provides its development-only Tools service binding. At development startup, the CLI reads the app's Git origin, saved ContextLayer login, and assembled current-folder configuration. The restart prerequisites are described under [Local login and assignment](#local-login-and-assignment). Production builds exclude local credentials and the auxiliary Worker.

The app retains its routes, `public/slate.json`, and thin Worker/configuration files. `@usecontextlayer/sdk/worker` owns the React Router request handler and capability context setup.

## App requirements and saved assignments

The platform frame loader reads the browser viewer's profile and requirement/assignment rows through the shared app-connection listing operation. Signed-in viewers can inspect their required services and select accounts through each row's controls. The connected-services status counts missing assignments; it does not validate provider status. Anonymous frames show “Not signed in” without a connection status or tray. These data stay in the frame.

The Slate schema and viewer/owner requirements live in `@usecontextlayer/shared/slate`. The neutral requirement/assignment response in `@usecontextlayer/shared/app-connections` is shared by platform and CLI. Selecting an account saves the assignment and React Router revalidates the tray automatically. Connect account opens authorization in a new tab; refresh the app page afterward to select the new account. Changes made elsewhere appear on the next frame load. The tray does not refresh the app's route data. Chrome is disabled during local development. Vite does not expose local configuration or app identity through a browser configuration plugin; the selected local connection inputs and credentials remain behind the Tools service binding. Restart development after editing requirements or bindings.

`createApp` returns the exported `App` type from `@usecontextlayer/sdk/worker`, derived from Cloudflare's native `ExportedHandler` fetch contract. The SDK owns its local binding and request-props types. This gives the generated Worker a portable public declaration under the Cloudflare scaffold's composite TypeScript configuration.
