import { WorkerEntrypoint } from "cloudflare:workers"
import type { LocalResourceConfiguration } from "@/lib/app-resources"
import { toolResultSchema } from "@/lib/tools"

export interface ToolsProps {
	appId: string
	credential: { token: string; type: "session" }
}

export interface LocalToolsProps {
	appId: string
	connections: LocalResourceConfiguration["connections"]
	credential: { token: string; type: "access-token" }
}

export interface McpToolsProps {
	appId: string
	name: string
	credential: { token: string; type: "access-token" }
}

export class Tools extends WorkerEntrypoint<{ CTX_PLATFORM_URL: string }, ToolsProps> {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const { appId, credential } = this.ctx.props
		return executeToolRequest(
			new Request(new URL(`/api/apps/${appId}/tools/call`, this.env.CTX_PLATFORM_URL), {
				body: JSON.stringify({ arguments: args, slug, tool: toolSlug }),
				headers: {
					"content-type": "application/json",
					cookie: `ctx-viewer-auth=${credential.token}`,
				},
				method: "POST",
			}),
		)
	}
}

export class McpTools extends WorkerEntrypoint<
	{ CTX_PLATFORM_URL: string },
	McpToolsProps
> {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const { appId, name, credential } = this.ctx.props
		return executeToolRequest(
			new Request(
				new URL(
					`/api/apps/${appId}/mcp/${encodeURIComponent(name)}/tools/call`,
					this.env.CTX_PLATFORM_URL,
				),
				{
					body: JSON.stringify({ arguments: args, slug, tool: toolSlug }),
					headers: {
						authorization: `Bearer ${credential.token}`,
						"content-type": "application/json",
					},
					method: "POST",
				},
			),
		)
	}
}

export class LocalTools extends WorkerEntrypoint<
	{ CTX_PLATFORM_URL: string },
	LocalToolsProps
> {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const { appId, connections, credential } = this.ctx.props
		const connection = new Map(Object.entries(connections)).get(slug)
		if (!connection) throw new Error(`No local app connection requirement for "${slug}"`)
		if (connection.connection_id === null) {
			throw new Error(
				`No local account assigned to "${slug}". Run ctx connection local assign ${slug}.`,
			)
		}
		return executeToolRequest(
			new Request(
				new URL(
					`/api/connections/${encodeURIComponent(connection.connection_id)}/tools/call`,
					this.env.CTX_PLATFORM_URL,
				),
				{
					body: JSON.stringify({
						app_id: appId,
						arguments: args,
						tool: toolSlug,
						toolkit: connection.toolkit,
					}),
					headers: {
						authorization: `Bearer ${credential.token}`,
						"content-type": "application/json",
					},
					method: "POST",
				},
			),
		)
	}
}

async function executeToolRequest(request: Request) {
	const response = await fetch(request)
	if (!response.ok) throw new Error(`Tool call failed: HTTP ${response.status}`)
	const result = toolResultSchema.parse(await response.json())
	if (result.error !== null) throw new Error(`${result.error} (log: ${result.logId})`)
	return { data: result.data, logId: result.logId }
}
