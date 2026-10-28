# @usecontextlayer/sdk

ContextLayer integration for slates: the app's shared document Layout, a Worker serving app routes and MCP tools, and Tools and Databases capabilities for app routes. The [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) defines slates, declarations, resources, Owners, and assignments.

Use Node.js 22.22.0 or newer, pnpm, and Git with configured author identity. Start with login, then create and run your slate:

```sh
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-slate
cd my-slate
pnpm dev
```

The CLI installs this package and configures local development. Open the local URL printed by the development server. Initialization prints your dashboard link, hosted URL, and Git deployment steps; the hosted URL becomes usable after deployment succeeds. Use `npx @usecontextlayer/cli` for subsequent CLI commands. First-party `@usecontextlayer/*` packages are exempt from pnpm's release-age policy in generated checkouts.

## Local login and assignment

See [Local login and assignment](https://docs.usecontextlayer.com/reference/sdk#local-login-and-assignment) for startup and restart prerequisites. Follow [Connect an account](https://docs.usecontextlayer.com/how-to/connect-an-account) for local and hosted setup.

## App Layout

Read the [App Layout reference](https://docs.usecontextlayer.com/reference/sdk#app-layout) before changing the generated root document.

## Standalone HTML pages

Use the [htmlPage reference and example](https://docs.usecontextlayer.com/reference/sdk#standalone-html-pages) when serving a standalone HTML document.

## Call connected services

See [Tools](https://docs.usecontextlayer.com/reference/sdk#tools) for calls from loaders and actions, including arguments and results.

## Handling tool errors

Follow [Missing resource setup](https://docs.usecontextlayer.com/reference/sdk#missing-resource-setup) when customizing an error boundary.

## Vite and Worker configuration

See [Vite and Worker configuration](https://docs.usecontextlayer.com/reference/sdk#vite-and-worker-configuration) before changing the generated integration.

## A loader that queries cached data

Use the [Databases reference](https://docs.usecontextlayer.com/reference/sdk#databases) for Kysely and direct SQL APIs. Follow [Add a database](https://docs.usecontextlayer.com/how-to/add-a-database) for declarations, migrations, and generated query types.
