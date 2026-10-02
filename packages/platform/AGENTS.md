# Platform

## OpenAPI, Zod, and Shared Domain Functions

**OpenAPI endpoints are the default for application APIs. Zod is the default for validation. Each operation has one service/domain function that owns its business logic and database calls, shared by the API endpoint and the server-side loader or action.** This applies even when the operation is a simple database query.

- **Schemas own the contract.** Define API input and output schemas with Zod. Use the schemas for validation, inferred TypeScript types, and generated OpenAPI documentation rather than maintaining separate definitions. Reuse the same input schemas wherever an API handler or loader accepts the same untrusted input.
- **API handlers own HTTP.** Parse and validate request inputs, call the service/domain function, and translate its result into the HTTP response. Business decisions and database queries belong in the shared function.
- **Loaders and actions call the same function directly.** React Router server loaders/actions invoke it in-process. They do not call our own API over HTTP or implement a second database path. They validate their untrusted inputs and adapt the result to the framework's response conventions.
- **Service/domain functions own the operation.** They accept typed, normalized arguments, enforce business rules, perform database reads/writes, and return typed results. They do not accept framework request/context objects or return HTTP responses. This keeps the operation's behavior the same for every caller.
- **Use ordinary functions grouped by domain.** This ownership boundary does not require service classes, a generic repository layer, or a dependency-injection framework. One operation has one implementation, regardless of how many entry points call it.

For example, both `GET /api/apps` and the app-listing loader call `listApps(...)`; `listApps(...)` owns the database query. The endpoint validates inputs and serializes an API response, while the loader supplies the result to the page. OpenAPI support and the shared function are part of the default shape from the first implementation.

## UI

Use pure shadcn/ui with the `base-nova` style for the platform dashboard. Add components through the shadcn CLI and compose them with standard Tailwind layout utilities. Keep the preset's tokens and component styling; do not introduce a parallel custom visual system.

The lowercase `contextlayer` wordmark uses Fugaz One at weight 400, matching the website, through the `font-logo` utility. Dashboard text uses Geist.

Use Font Awesome Slab Regular icons through the official React component and npm kit. Apps use the box icon. See [.font-awesome.md](.font-awesome.md) for imports and setup.

## App identity and storage

The platform owns `app.id` (Postgres UUID primary key) and `app.public_hostname` (unique index). No display name. The UUID names the Artifacts repository and is the immutable `/git/<app-id>` address. Creation happens through `POST /api/apps` during `ctx init`, not on first push. Use the existing `db-infra` helpers, package-owned Kysely migrations, and Kanel-generated models. Never hand-edit generated models. The server owns its database connection; migrations run through the package's database management commands.

The package sets `verbatimModuleSyntax: false`, matching old-v2’s Kanel-backed packages, because Kanel emits a default export of the Database type. Keep generated files unmodified.

## Workers runtime

Platform runs on Cloudflare Workers through `react-router-hono-server/cloudflare` and the Cloudflare Vite plugin. Use workerd for local development and Wrangler for local production verification. Configuration comes from Worker bindings, validated in `env.ts`. Hono middleware owns each request's Postgres.js/Kysely connection, shares it with API handlers and React Router loaders, and closes it through `waitUntil`. Keep migrations and Kanel generation in the Node CLI; do not run them inside the Worker.

Use the native `ARTIFACTS` Worker binding directly in domain functions. Repository handles implement `Disposable`: acquire them with `using`. The namespace belongs in Wrangler configuration; runtime Artifacts REST clients and API-token secrets are unnecessary.
