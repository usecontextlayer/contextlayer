import type { ToolConfig } from "@modelcontextprotocol/ext-apps/server"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { createRequestHandler, RouterContextProvider } from "react-router"
import type { z } from "zod"
import { type Tools, toolsContext } from "@/index"

interface LocalBindings {
	TOOLS: Tools
}

interface AppProps {
	tools: Tools
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

export type App = Required<
	Pick<ExportedHandler<LocalBindings, unknown, unknown, AppProps>, "fetch">
>

export function createApp({
	build,
	mode,
	development,
	mcp = {},
}: {
	build: Parameters<typeof createRequestHandler>[0]
	mode: string
	development: boolean
	mcp?: Record<string, McpToolModule>
}): App {
	const requestHandler = createRequestHandler(build, mode)
	return {
		async fetch(request, env, ctx) {
			if (ctx.props.mcpTool) {
				const module = Object.values(mcp).find(
					({ tool }) => tool.name === ctx.props.mcpTool,
				)
				if (!module) throw new Error(`Unknown MCP tool: ${ctx.props.mcpTool}`)
				const args = await module.tool.inputSchema.parseAsync(await request.json())
				return Response.json(await module.handler(args, ctx.props.tools))
			}
			const context = new RouterContextProvider()
			context.set(toolsContext, development ? env.TOOLS : ctx.props.tools)
			return requestHandler(request, context)
		},
	}
}
