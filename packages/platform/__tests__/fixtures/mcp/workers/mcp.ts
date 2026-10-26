import type { SlateWorker } from "@usecontextlayer/sdk/worker"
import slate from "@/workers/app"

const worker: SlateWorker = {
	async fetch(request, env, ctx) {
		const response = await slate.fetch(request, env, ctx)
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
}

export default worker
