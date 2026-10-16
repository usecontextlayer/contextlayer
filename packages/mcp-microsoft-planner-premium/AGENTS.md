# Planner Premium MCP Worker

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for ownership and trust boundaries and [DEVELOPING.md](../../DEVELOPING.md) for repository-wide setup and task conventions.

## Development and verification

This package uses Wrangler for local development and deployment dry-run builds. From the repository root:

```sh
pnpm exec turbo run dev --filter=@usecontextlayer/mcp-microsoft-planner-premium
pnpm exec turbo run test tsc build --filter=@usecontextlayer/mcp-microsoft-planner-premium
```

Unit tests replay the committed Dataverse recordings and exercise the HTTP authentication flow without credentials, Dataverse access or a separately running service. Open `/authorize` on the local URL to preview the connection form; completing authorization requires the Entra configuration below.

For a live local connection, inject the shared application credentials through Doppler:

```sh
doppler run -p platform -c prod -- pnpm exec turbo run dev --filter=@usecontextlayer/mcp-microsoft-planner-premium
```

The package's Turbo configuration passes the two Microsoft variables to Wrangler, which loads the declared `secrets.required` from the process environment. Keep credentials out of local source files.

## Microsoft data contracts

Carry supported native Microsoft entity fields, action parameters and response fields through the package without aliases or value normalization. Use `@odata.type`, the actual `msdyn_*` columns and Microsoft’s case-sensitive OData bindings. Preserve Microsoft’s distinct read lookup properties, write navigation properties and action parameter names. Keep operation grouping, same-call refs and other package workflow metadata distinct from Microsoft fields. Native vocabulary does not expand supported writes beyond recorded fields and operations.

Preserve a minted `OperationSetReceipt` and original error causes through the operation-set lifecycle, including failures. Serialize failures only at the MCP boundary with explicit `isError` and `OperationSetId` in text content, because uncaught SDK errors and Composio’s error path do not preserve arbitrary error properties. An execute rejection does not establish the set’s status; use the native status read.

Reads use native Dataverse queries rooted in Planner entity sets. Preserve query expressions and response objects, including custom columns, formatted annotations and continuation links. Dataverse owns related-record permissions; do not introduce a package-specific `$expand` language or relationship allowlist. Keep initial retrieval and continuation as separate tool contracts over the same authenticated read path. A continuation must stay within the connection's environment and an allowed Planner root, and its encoded query must remain unchanged. Tool descriptions own input usage and examples.

## Deployment

Configure the two Wrangler secrets declared in [wrangler.jsonc](wrangler.jsonc): `MICROSOFT_CLIENT_ID` for the shared multi-tenant ContextLayer Entra application (`aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11`) and `MICROSOFT_CLIENT_SECRET` for that application's Web client secret. There is no deployment-level tenant or Dataverse org setting; the person connecting selects their Dataverse environment.

Their values in Doppler `platform/prod` reference `${web.prod.MICROSOFT_CLIENT_ID}` and `${web.prod.MICROSOFT_CLIENT_SECRET}`. Web owns the credentials; Planner consumes those same names and values. Changes to the source values reach the Worker on its next deployment. Doppler edits remain user-operated.

The production Worker is `contextlayer-mcp-microsoft-planner-premium`, at `https://microsoft-planner-premium.mcp.usecontextlayer.com`. Its Wrangler configuration owns the Custom Domain. Follow the root [deployment workflow](../../DEVELOPING.md#releases-and-deployment), using `mcp-microsoft-planner-premium` as the package argument for both build and deploy. Workers Builds targets this repository's `main` at root `/`, with the shared build settings described there. Its masked `DOPPLER_TOKEN` build secret uses the dedicated read-only `platform/prod` service token named `contextlayer-mcp-microsoft-planner-premium-builds`.

The production Composio toolkit is `CUSTOM_MICROSOFT_PLANNER_PREMIUM`, displayed as Microsoft Planner Premium. It is registered as a Custom MCP toolkit in `DCR_OAUTH` mode, with `discovery_url` pointing to the Worker's `/.well-known/oauth-authorization-server` and `app_url` to its `/mcp`. Composio's callback, `https://backend.composio.dev/api/v1/auth-apps/add`, must be registered as a Web redirect URI on the Entra application before connecting. Changes to that application registration require explicit user approval.

No code registers the toolkit; it is registered with this request against Composio's REST API, using the production Composio project key from Doppler `platform/prod`. Its logo is [logo.svg](logo.svg), Microsoft's Dataverse icon from the Power Platform icon pack, used under ContextLayer's license from Microsoft; never alter it. Composio accepts only a square PNG or JPEG between 256 and 1024 pixels, so the request rasterizes the SVG with `rsvg-convert` (Homebrew `librsvg`). From the repository root:

```sh
LOGO=$(rsvg-convert -w 512 -h 512 packages/mcp-microsoft-planner-premium/logo.svg | base64 | tr -d '\n')
doppler run -p platform -c prod -- sh -c 'curl -s -X POST https://backend.composio.dev/api/v3.1/custom/toolkits/upsert -H "x-api-key: $COMPOSIO_API_KEY" -H "Content-Type: application/json" -d @-' <<JSON
{
	"slug": "MICROSOFT_PLANNER_PREMIUM",
	"toolkit_config": {
		"name": "Microsoft Planner Premium",
		"app_url": "https://microsoft-planner-premium.mcp.usecontextlayer.com/mcp",
		"logo_file": { "content": "$LOGO", "mime_type": "image/png" },
		"auth_schemes": [
			{
				"mode": "DCR_OAUTH",
				"discovery_url": "https://microsoft-planner-premium.mcp.usecontextlayer.com/.well-known/oauth-authorization-server"
			}
		]
	}
}
JSON
```

Re-sending the identical body is a no-op, and changing only `name` or `logo_file` updates the toolkit in place. Composio refuses a changed `app_url` or `auth_schemes` with `409`; replacing either means deleting and re-registering the toolkit, which revokes every connection.

Before onboarding a user, verify the deployed discovery documents, complete the real Composio connection flow including Dataverse org selection, and invoke `retrieve_records` for `msdyn_projects` through that connection. Confirm the results belong to the selected org. After the access token expires, verify that Composio refreshes it and another project read succeeds. Exercise operation-set submission and completion only with explicit permission for each exact customer write. A successful build or connection screen alone does not establish this live verification.

## Connection page

Use `htmlPage` from `@usecontextlayer/sdk/html` for the authorization page's document and responsive card; see the [SDK example](../sdk/README.md#standalone-html-pages). Keep the form's content and OAuth parameters in this package. Use standard Bootstrap 6 classes, with no custom CSS or client-side form machinery.

## The recordings

The recorder in [lib/cassette/record.ts](lib/cassette/record.ts) is the only writer of `lib/__goldens__/schedule-api.json`; its header documents invocation and token-file input (`CTX_DATAVERSE_TOKEN_FILE`). Never hand-edit the cassette, and never make the recorder part of tests, builds or checks. It drives real writes to a customer's approved production board, so refreshing the recording requires explicit per-write customer permission under the root [customer-data rule](../../AGENTS.md#never-write-to-customer-data-without-per-write-permission).

[lib/cassette/record-reads.ts](lib/cassette/record-reads.ts) is the only writer of `lib/__goldens__/records.json`. Its header owns invocation and read prerequisites. It only reads existing records, normalizes customer content before persistence, and records native small pages for continuation evidence; the tools themselves use Dataverse's default page size. Both cassettes use the shared interaction model and replay server. Refreshing reads does not authorize running the write recorder.
