import { WorkerEntrypoint } from "cloudflare:workers"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"
import type { Tools as ToolsContract } from "@/index"
import { version } from "@/package.json"

const textBlock = z.object({ text: z.string(), type: z.literal("text") })
const execution = z.object({
	data: z.object({
		results: z.tuple([
			z.object({
				response: z.object({ data: z.unknown(), successful: z.literal(true) }),
			}),
		]),
	}),
	log_id: z.string(),
	successful: z.literal(true),
})

export class Tools extends WorkerEntrypoint<Bindings> implements ToolsContract {
	async call(accountAlias: string, toolSlug: string, args: Record<string, unknown>) {
		const env = parseEnv(this.env)
		const client = new Client({ name: "contextlayer-local-tools", version })
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL("https://connect.composio.dev/mcp"), {
					requestInit: { headers: { "x-consumer-api-key": env.COMPOSIO_CONSUMER_KEY } },
				}),
			)
			const result = await client.callTool({
				arguments: {
					sync_response_to_workbench: false,
					tools: [{ account: accountAlias, arguments: args, tool_slug: toolSlug }],
				},
				name: "COMPOSIO_MULTI_EXECUTE_TOOL",
			})
			if (result.isError) throw new Error(JSON.stringify(result.content))
			const text = textBlock.parse(result.content[0]).text
			const response = execution.parse(JSON.parse(text))
			return { data: response.data.results[0].response.data, logId: response.log_id }
		} finally {
			await client.close()
		}
	}
}
