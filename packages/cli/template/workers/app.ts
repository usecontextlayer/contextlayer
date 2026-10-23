import {
	createSlateWorker,
	type McpToolModule,
	type SlateWorker,
} from "@usecontextlayer/sdk/worker"

const worker: SlateWorker = createSlateWorker({
	build: () => import("virtual:react-router/server-build"),
	development: import.meta.env.DEV,
	mcp: import.meta.glob<McpToolModule>("/mcp/*/index.ts", { eager: true }),
	mode: import.meta.env.MODE,
})

export default worker
