import { WorkerEntrypoint } from "cloudflare:workers"
import type { z } from "zod"
import type { LocalResourceConfiguration } from "@/lib/app-resources"
import type { DatabaseResult, databaseQuerySchema } from "@/lib/databases"
import { connectionRequiredSchema, toolResultSchema } from "@/lib/tools"

export type HostedExecutionResult<T> =
	| { allowed: true; result: T }
	| ({ allowed: false } & z.infer<typeof connectionRequiredSchema>)
	| {
			allowed: false
			message: string
			reason: "subscription-required" | "credits-exhausted"
	  }
	| {
			allowed: false
			reason:
				| "membership-required"
				| "not-declared"
				| "not-found"
				| "sign-in-required"
				| "forbidden"
	  }

export function readHostedExecutionResult<T>(result: HostedExecutionResult<T>): T {
	if (!result.allowed)
		throw new Error("message" in result ? result.message : result.reason)
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
		if (!result.allowed && result.reason === "connection-required")
			return connectionRequiredResponse(result.slug)
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
		if (!connection) throw new Error("not-declared")
		if (connection.connection_id === null) return connectionRequiredResponse(slug)
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
	if (response.status === 409) {
		const setup = connectionRequiredSchema.parse(await response.json())
		return connectionRequiredResponse(setup.slug)
	}
	if (response.status === 402) throw new Error(await response.text())
	if (!response.ok) throw new Error(`Tool call failed: HTTP ${response.status}`)
	const result = toolResultSchema.parse(await response.json())
	return readToolResult(result)
}

function readToolResult(result: z.infer<typeof toolResultSchema>) {
	if (result.error !== null) throw new Error(`${result.error} (log: ${result.logId})`)
	return { data: result.data, logId: result.logId }
}

function connectionRequiredResponse(slug: string) {
	return Response.json(
		{ reason: "connection-required", slug },
		{ status: 409, statusText: "Connection required" },
	)
}
