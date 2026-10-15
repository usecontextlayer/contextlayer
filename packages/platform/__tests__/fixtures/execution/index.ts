import { Databases } from "@usecontextlayer/shared/databases-worker"
import {
	type HostedExecution,
	Tools,
	type ToolsProps,
} from "@usecontextlayer/shared/tools-worker"

export { Databases, Tools }

export default {
	async fetch(request, env, ctx) {
		const method = new URL(request.url).pathname
		if (method === "/callTool") {
			const args = await request.json<Parameters<HostedExecution["callTool"]>>()
			return Response.json(await env.EXECUTION.callTool(...args))
		}
		if (method === "/queryDatabase") {
			const args = await request.json<Parameters<HostedExecution["queryDatabase"]>>()
			return Response.json(await env.EXECUTION.queryDatabase(...args))
		}
		const entrypoints = ctx.exports as {
			Databases: LoopbackForExport<typeof Databases>
			Tools: LoopbackForExport<typeof Tools>
		}
		try {
			if (method === "/tools") {
				const [props, args] =
					await request.json<[ToolsProps, Parameters<Tools["call"]>]>()
				const result = await entrypoints.Tools({ props }).call(...args)
				return result instanceof Response ? result : Response.json(result)
			}
			if (method === "/databases") {
				const [props, args] =
					await request.json<[ToolsProps, Parameters<Databases["query"]>]>()
				const result = await entrypoints.Databases({ props }).query(...args)
				return result instanceof Response ? result : Response.json(result)
			}
		} catch (error) {
			if (error instanceof Error)
				return Response.json({ error: error.message }, { status: 400 })
			throw error
		}
		return new Response("Not Found", { status: 404 })
	},
} satisfies ExportedHandler<{ EXECUTION: HostedExecution }>
