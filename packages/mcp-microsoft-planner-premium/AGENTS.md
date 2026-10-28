# Planner Premium MCP Worker

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for ownership and trust boundaries and [DEVELOPING.md](../../DEVELOPING.md) for repository-wide setup and task conventions.

See [TESTING.md](../../TESTING.md#recorded-apis) for the recording policy and [live onboarding verification](../../TESTING.md#planner-onboarding).

## Microsoft data contracts

Carry supported native Microsoft entity fields, action parameters and response fields through the package without aliases or value normalization. Use `@odata.type`, the actual `msdyn_*` columns and Microsoft’s case-sensitive OData bindings. Preserve Microsoft’s distinct read lookup properties, write navigation properties and action parameter names. Keep operation grouping, same-call refs and other package workflow metadata distinct from Microsoft fields. Native vocabulary does not expand supported writes beyond recorded fields and operations.

Preserve a minted `OperationSetReceipt` and original error causes through the operation-set lifecycle, including failures. Serialize failures only at the MCP boundary with explicit `isError` and `OperationSetId` in text content, because uncaught SDK errors and Composio’s error path do not preserve arbitrary error properties. An execute rejection does not establish the set’s status; use the native status read.

Reads use native Dataverse queries rooted in Planner entity sets. Preserve query expressions and response objects, including custom columns, formatted annotations and continuation links. Dataverse owns related-record permissions; do not introduce a package-specific `$expand` language or relationship allowlist. Keep initial retrieval and continuation as separate tool contracts over the same authenticated read path. A continuation must stay within the connection's environment and an allowed Planner root, and its encoded query must remain unchanged. Tool descriptions own input usage and examples.

## Authentication and connection ownership

Use Dataverse queries for reads and the Schedule API for writes. Deployment selects the shared multi-tenant Entra application; each connection selects its Dataverse organization, bound to the token's audience. Microsoft owns consent and token issuance, Composio stores and refreshes credentials, and this Worker must not store clients, codes or tokens. These Microsoft-issued tokens are separate from Better Auth's slate-resource credentials; this service involves no ContextLayer slate.

At the HTTP edge, check bearer claims and expiry and confine credential forwarding to supported Dataverse HTTPS origins derived from the audience. These checks do not verify Microsoft's signature: Dataverse validates the forwarded credential. Preserve that distinction when extending authentication; parsed claims alone do not establish verified identity. Initial reads and continuations must share the authenticated client and the environment boundary above.

## Connection page

Use `htmlPage` from `@usecontextlayer/sdk/html` for the authorization page's document and responsive card; see the [SDK example](../sdk/README.md#standalone-html-pages). Keep the form's content and OAuth parameters in this package. Use standard Bootstrap 6 classes, with no custom CSS or client-side form machinery.

## Development

This package uses Wrangler for local development and deployment dry-run builds. From the repository root:

```sh
pnpm exec turbo run dev --filter=@usecontextlayer/mcp-microsoft-planner-premium
```

Open `/authorize` on the local URL to preview the connection form; completing authorization requires the Entra configuration below.

For a live local connection, inject the shared application credentials through Doppler:

```sh
doppler run -p platform -c prod -- pnpm exec turbo run dev --filter=@usecontextlayer/mcp-microsoft-planner-premium
```

The package's Turbo configuration passes the two Microsoft variables to Wrangler, which loads the declared `secrets.required` from the process environment. Keep credentials out of local source files.

## Deployment

Configure the two Wrangler secrets declared in [wrangler.jsonc](wrangler.jsonc): `MICROSOFT_CLIENT_ID` for the shared multi-tenant ContextLayer Entra application (`aaf9e242-3a1f-4d36-b9ee-f1a11c2b2c11`) and `MICROSOFT_CLIENT_SECRET` for that application's Web client secret. There is no deployment-level tenant or Dataverse org setting; the person connecting selects their Dataverse environment.

Their values in Doppler `platform/prod` reference `${web.prod.MICROSOFT_CLIENT_ID}` and `${web.prod.MICROSOFT_CLIENT_SECRET}`. Web owns the credentials; Planner consumes those same names and values. Changes to the source values reach the Worker on its next deployment. Doppler edits remain user-operated.

Follow the root [deployment workflow](../../DEVELOPING.md#service-deployment), using `mcp-microsoft-planner-premium` as the package argument for both build and deploy. [Wrangler configuration](wrangler.jsonc) owns the Worker name and Custom Domain. The masked `DOPPLER_TOKEN` build secret uses the dedicated read-only `platform/prod` service token named `contextlayer-mcp-microsoft-planner-premium-builds`.

### Composio toolkit registration

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

### Resync after tool changes

Composio stores a snapshot of the toolkit’s tools and does not refresh it on its own. A deployment that adds, removes or renames a tool, or changes a tool’s input schema, leaves Composio serving the old list. Calls to new tools return `Tool_ToolNotFound`, and calls to removed ones reach the Worker and fail. After such a deployment, resync through an active connection of this toolkit:

```sh
doppler run -p platform -c prod -- sh -c 'curl -s -X POST https://backend.composio.dev/api/v3.1/custom/toolkits/sync -H "x-api-key: $COMPOSIO_API_KEY" -H "Content-Type: application/json" -d "{\"slug\":\"CUSTOM_MICROSOFT_PLANNER_PREMIUM\",\"connected_account_id\":\"<an ACTIVE ca_ id>\"}"'
```

It returns the new toolkit `version` and `synced_count`.
