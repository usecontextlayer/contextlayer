# Premium Planner MCP Worker

This package uses the same Wrangler build and development tasks as the other standalone Workers. Its unit tests need no credentials, Dataverse access or local service.

## Deployment

A deployment needs four Wrangler secrets: `CTX_ENTRA_CLIENT_ID` (the ContextLayer Entra application, `aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11`), `CTX_ENTRA_CLIENT_SECRET` (that application's Web client secret), `CTX_ENTRA_TENANT` (the Microsoft endpoint tenant segment), and `CTX_DATAVERSE_ORG_URL` (the org the deployment serves). Register it in Composio as a Custom MCP toolkit in `DCR_OAUTH` mode with `discovery_url` at `/.well-known/oauth-authorization-server` and `app_url` at `/mcp`. Composio's OAuth callback, `https://backend.composio.dev/api/v1/auth-apps/add`, must be a Web redirect URI on that Entra application before anyone can connect.

## The recording

The recorder in `lib/cassette/record.ts` is the only writer of `lib/__goldens__/schedule-api.json`. It reads a delegated Dataverse token from the file named by `DV_TOKEN_FILE`. Never hand-edit the cassette, and never make the recorder part of tests, builds or checks. It drives real writes to a customer's approved board, so refreshing the recording requires explicit per-write customer permission, as the root `AGENTS.md` requires.
