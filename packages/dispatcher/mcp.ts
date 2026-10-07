import { CallToolResultSchema } from "@modelcontextprotocol/core"
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { recordAppUsage, type resolvedAppSchema } from "@usecontextlayer/shared/app-usage"
import { MCP_MANIFEST_PATH, mcpManifestSchema } from "@usecontextlayer/shared/mcp"
import { z } from "zod"
import type { parseEnv } from "@/env"

export async function serveMcp(
	request: Request,
	namespace: DispatchNamespace,
	app: z.infer<typeof resolvedAppSchema>,
	env: ReturnType<typeof parseEnv>,
	ctx: Pick<ExecutionContext, "waitUntil">,
) {
	const assetWorker = namespace.get(app.id)
	const response = await assetWorker.fetch(new URL(MCP_MANIFEST_PATH, request.url).href)
	if (!response.ok) throw new Error(`MCP manifest: HTTP ${response.status}`)
	const manifest = mcpManifestSchema.parse(await response.json())
	const handler = createMcpHandler(() => {
		const server = new McpServer({
			name: new URL(request.url).hostname,
			version: "1.0.0",
		})
		for (const {
			slate,
			inputSchema,
			outputSchema,
			name,
			...definition
		} of manifest.tools) {
			if (
				Object.keys(slate.connections).length ||
				Object.keys(slate.folders).length ||
				Object.keys(slate.secrets).length
			) {
				throw new Error(`${name}: MCP resource consumers are not implemented yet`)
			}
			registerAppTool(
				server,
				name,
				{
					...definition,
					_meta: definition._meta ?? {},
					inputSchema: z.fromJSONSchema(inputSchema as z.core.JSONSchema.JSONSchema),
					outputSchema: outputSchema
						? z.fromJSONSchema(outputSchema as z.core.JSONSchema.JSONSchema)
						: undefined,
				},
				async (args) => {
					const result = await namespace.get(app.id, { props: { mcpTool: name } }).fetch(
						new Request(request.url, {
							body: JSON.stringify(args),
							headers: { "content-type": "application/json" },
							method: "POST",
						}),
					)
					if (!result.ok) throw new Error(`${name}: HTTP ${result.status}`)
					const output = CallToolResultSchema.parse(await result.json())
					const polar = createPolarCore({
						accessToken: env.POLAR_ACCESS_TOKEN,
						environment: env.POLAR_ENVIRONMENT,
					})
					ctx.waitUntil(recordAppUsage(polar, app, "tool_call"))
					return output
				},
			)
		}
		for (const { name, uri, path, ...metadata } of manifest.resources) {
			registerAppResource(server, name, uri, metadata, async () => {
				const resource = await assetWorker.fetch(new URL(path, request.url).href)
				if (!resource.ok) throw new Error(`${uri}: HTTP ${resource.status}`)
				return {
					contents: [{ mimeType: RESOURCE_MIME_TYPE, text: await resource.text(), uri }],
				}
			})
		}
		return server
	})
	return handler.fetch(request)
}
