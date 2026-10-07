import { type App, createApp, type McpToolModule } from "@usecontextlayer/sdk/worker"

const app = createApp({
	build: () => import("virtual:react-router/server-build"),
	development: import.meta.env.DEV,
	mcp: import.meta.glob<McpToolModule>("/mcp/*/index.ts", { eager: true }),
	mode: import.meta.env.MODE,
})

export default {
	async fetch(request, env, ctx) {
		const response = await app.fetch(request, env, ctx)
		if (!ctx.props.mcpTool) return response
		const result = await response.json<{ structuredContent: Record<string, unknown> }>()
		return Response.json({
			...result,
			structuredContent: {
				...result.structuredContent,
				authorization: request.headers.get("authorization"),
			},
		})
	},
} satisfies App
