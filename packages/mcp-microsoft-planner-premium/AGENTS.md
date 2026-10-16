# Planner Premium MCP Worker

This package uses the same Wrangler build and development tasks as the other standalone Workers. Its unit tests need no credentials, Dataverse access or local service.

## Microsoft data contracts

Carry supported native Microsoft entity fields, action parameters and response fields through the package without aliases or value normalization. Use `@odata.type`, the actual `msdyn_*` columns and Microsoft’s case-sensitive OData bindings. Preserve Microsoft’s distinct read lookup properties, write navigation properties and action parameter names. Keep operation grouping, same-call refs and other package workflow metadata distinct from Microsoft fields. Native vocabulary does not imply support for unrecorded fields or unrestricted writes.

## Deployment

A deployment needs two Wrangler secrets: `CTX_ENTRA_CLIENT_ID` (the shared multi-tenant ContextLayer Entra application, `aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11`) and `CTX_ENTRA_CLIENT_SECRET` (that application's Web client secret). Microsoft endpoints use the constant `organizations` tenant segment. The person connecting chooses their Dataverse environment URL on `/authorize`; `/mcp` derives the org from the token's audience. Register it in Composio as a Custom MCP toolkit in `DCR_OAUTH` mode with `discovery_url` at `/.well-known/oauth-authorization-server` and `app_url` at `/mcp`. Composio's OAuth callback, `https://backend.composio.dev/api/v1/auth-apps/add`, must be a Web redirect URI on that Entra application before anyone can connect.

## Connection page

Use `htmlPage` from `@usecontextlayer/sdk/html` for the authorization page's document and responsive card. Keep the form's content and OAuth parameters in this package. Use standard Bootstrap 6 classes, with no custom CSS or client-side form machinery.

## The recording

The recorder in `lib/cassette/record.ts` is the only writer of `lib/__goldens__/schedule-api.json`. It reads a delegated Dataverse token from the file named by `DV_TOKEN_FILE`. Never hand-edit the cassette, and never make the recorder part of tests, builds or checks. It drives real writes to a customer's approved board, so refreshing the recording requires explicit per-write customer permission, as the root `AGENTS.md` requires.
