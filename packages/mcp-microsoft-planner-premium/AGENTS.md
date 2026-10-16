# Planner Premium MCP Worker

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for ownership and trust boundaries and [DEVELOPING.md](../../DEVELOPING.md) for repository-wide setup and task conventions.

## Development and verification

This package uses Wrangler for local development and deployment dry-run builds. From the repository root:

```sh
pnpm exec turbo run dev --filter=@usecontextlayer/mcp-microsoft-planner-premium
pnpm exec turbo run test tsc build --filter=@usecontextlayer/mcp-microsoft-planner-premium
```

Unit tests replay the committed Dataverse recording and exercise the HTTP authentication flow without credentials, Dataverse access or a separately running service. Open `/authorize` on the local URL to preview the connection form; completing authorization requires the Entra configuration below.

## Microsoft data contracts

Carry supported native Microsoft entity fields, action parameters and response fields through the package without aliases or value normalization. Use `@odata.type`, the actual `msdyn_*` columns and Microsoft’s case-sensitive OData bindings. Preserve Microsoft’s distinct read lookup properties, write navigation properties and action parameter names. Keep operation grouping, same-call refs and other package workflow metadata distinct from Microsoft fields. Native vocabulary does not imply support for unrecorded fields or unrestricted writes.

## Deployment

Configure the two Wrangler secrets declared in [wrangler.jsonc](wrangler.jsonc): `CTX_ENTRA_CLIENT_ID` for the shared multi-tenant ContextLayer Entra application (`aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11`) and `CTX_ENTRA_CLIENT_SECRET` for that application's Web client secret. There is no deployment-level tenant or Dataverse org setting; the person connecting selects their Dataverse environment.

Register the Worker in Composio as a Custom MCP toolkit in `DCR_OAUTH` mode, with `discovery_url` pointing to its `/.well-known/oauth-authorization-server` and `app_url` to its `/mcp`. Composio's callback, `https://backend.composio.dev/api/v1/auth-apps/add`, must be registered as a Web redirect URI on the Entra application before connecting. Changes to that application registration require explicit user approval.

## Connection page

Use `htmlPage` from `@usecontextlayer/sdk/html` for the authorization page's document and responsive card; see the [SDK example](../sdk/README.md#standalone-html-pages). Keep the form's content and OAuth parameters in this package. Use standard Bootstrap 6 classes, with no custom CSS or client-side form machinery.

## The recording

The recorder in [lib/cassette/record.ts](lib/cassette/record.ts) is the only writer of `lib/__goldens__/schedule-api.json`; its header documents invocation and token-file input (`DV_TOKEN_FILE`). Never hand-edit the cassette, and never make the recorder part of tests, builds or checks. It drives real writes to a customer's approved production board, so refreshing the recording requires explicit per-write customer permission under the root [customer-data rule](../../AGENTS.md#never-write-to-customer-data-without-per-write-permission).
