import type { ToolConfig } from "@modelcontextprotocol/ext-apps/server"
import type { CallToolResult } from "@modelcontextprotocol/server"
import type { DatabasesBinding } from "@usecontextlayer/shared/databases"
import type { ToolsBinding } from "@usecontextlayer/shared/tools"
import { createRequestHandler, RouterContextProvider } from "react-router"
import type { z } from "zod"
import { type Databases, databasesContext, type Tools, toolsContext } from "@/index"

interface LocalBindings {
	DATABASES: DatabasesBinding
	TOOLS: ToolsBinding
}

interface SlateWorkerProps {
	databases: DatabasesBinding
	tools: ToolsBinding
	mcpTool?: string
}

export interface McpToolModule {
	tool: Omit<ToolConfig, "inputSchema" | "outputSchema"> & {
		name: string
		inputSchema: z.ZodType
		outputSchema?: z.ZodType
	}
	handler(args: unknown, tools: Tools): CallToolResult | Promise<CallToolResult>
}

export interface SlateWorker
	extends Required<
		Pick<ExportedHandler<LocalBindings, unknown, unknown, SlateWorkerProps>, "fetch">
	> {}

export function createSlateWorker({
	build,
	mode,
	development,
	mcp = {},
}: {
	build: Parameters<typeof createRequestHandler>[0]
	mode: string
	development: boolean
	mcp?: Record<string, McpToolModule>
}): SlateWorker {
	const requestHandler = createRequestHandler(build, mode)
	return {
		async fetch(request, env, ctx) {
			if (ctx.props.mcpTool) {
				const module = Object.values(mcp).find(
					({ tool }) => tool.name === ctx.props.mcpTool,
				)
				if (!module) throw new Error(`Unknown MCP tool: ${ctx.props.mcpTool}`)
				const args = await module.tool.inputSchema.parseAsync(await request.json())
				return Response.json(await module.handler(args, createTools(ctx.props.tools)))
			}
			const context = new RouterContextProvider()
			context.set(
				databasesContext,
				createDatabases(development ? env.DATABASES : ctx.props.databases),
			)
			context.set(toolsContext, createTools(development ? env.TOOLS : ctx.props.tools))
			return requestHandler(request, context)
		},
	}
}

function createDatabases(binding: DatabasesBinding): Databases {
	return {
		async query(...args) {
			const result = await binding.query(...args)
			if (result instanceof Response) throw result
			return result
		},
	}
}

function createTools(binding: ToolsBinding): Tools {
	return {
		async call(...args) {
			const result = await binding.call(...args)
			if (result instanceof Response) throw result
			return result
		},
	}
}
