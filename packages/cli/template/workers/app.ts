import { createApp, type McpToolModule } from "@usecontextlayer/sdk/worker"

export default createApp({
	build: () => import("virtual:react-router/server-build"),
	development: import.meta.env.DEV,
	mcp: import.meta.glob<McpToolModule>("/mcp/*/index.ts", { eager: true }),
	mode: import.meta.env.MODE,
})
