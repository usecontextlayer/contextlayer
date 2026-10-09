import type { HostedExecution } from "@usecontextlayer/shared/tools-worker"

export default {
	async fetch(request, env) {
		const method = new URL(request.url).pathname
		if (method === "/callTool") {
			const args = await request.json<Parameters<HostedExecution["callTool"]>>()
			return Response.json(await env.EXECUTION.callTool(...args))
		}
		if (method === "/queryDatabase") {
			const args = await request.json<Parameters<HostedExecution["queryDatabase"]>>()
			return Response.json(await env.EXECUTION.queryDatabase(...args))
		}
		return new Response("Not Found", { status: 404 })
	},
} satisfies ExportedHandler<{ EXECUTION: HostedExecution }>
