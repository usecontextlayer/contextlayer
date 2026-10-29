import { createSlateWorker, type McpToolModule } from "@usecontextlayer/sdk/worker"

export default createSlateWorker({
	development: import.meta.env.DEV,
	mcp: import.meta.glob<McpToolModule>("/mcp/*/index.ts", { eager: true }),
	mode: import.meta.env.MODE,
})
