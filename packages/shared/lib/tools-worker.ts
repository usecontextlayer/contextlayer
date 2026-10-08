import { WorkerEntrypoint } from "cloudflare:workers"
import type { z } from "zod"
import type { LocalResourceConfiguration } from "@/lib/app-resources"
import type { DatabaseResult, databaseQuerySchema } from "@/lib/databases"
import { toolResultSchema } from "@/lib/tools"

export type HostedExecutionResult<T> =
	| { allowed: true; result: T }
	| {
			allowed: false
			reason:
				| "membership-required"
				| "not-declared"
				| "not-found"
				| "sign-in-required"
				| "forbidden"
				| "subscription-required"
	  }

export function readHostedExecutionResult<T>(result: HostedExecutionResult<T>): T {
	if (!result.allowed) throw new Error(result.reason)
	return result.result
}

export interface HostedExecution {
	callTool(
		appId: string,
		viewerSessionToken: string,
		call: { slug: string; tool: string; arguments: Record<string, unknown> },
	): Promise<HostedExecutionResult<z.infer<typeof toolResultSchema>>>
	queryDatabase(
		appId: string,
		viewerSessionToken: string,
		query: z.input<typeof databaseQuerySchema>,
	): Promise<HostedExecutionResult<DatabaseResult>>
}

export interface ToolsProps {
	appId: string
	credential: { token: string; type: "session" }
}

export interface LocalToolsProps {
	appId: string
	connections: LocalResourceConfiguration["connections"]
	credential: { token: string; type: "access-token" }
}

export class Tools extends WorkerEntrypoint<{ EXECUTION: HostedExecution }, ToolsProps> {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const { appId, credential } = this.ctx.props
		const result = await this.env.EXECUTION.callTool(appId, credential.token, {
			arguments: args,
			slug,
			tool: toolSlug,
		})
		return readToolResult(toolResultSchema.parse(readHostedExecutionResult(result)))
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
		return readToolResponse(
			await fetch(
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
			),
		)
	}
}

async function readToolResponse(response: Response) {
	if (!response.ok) throw new Error(`Tool call failed: HTTP ${response.status}`)
	const result = toolResultSchema.parse(await response.json())
	return readToolResult(result)
}

function readToolResult(result: z.infer<typeof toolResultSchema>) {
	if (result.error !== null) throw new Error(`${result.error} (log: ${result.logId})`)
	return { data: result.data, logId: result.logId }
}
