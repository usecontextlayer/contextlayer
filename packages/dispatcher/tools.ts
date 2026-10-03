import { WorkerEntrypoint } from "cloudflare:workers"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"

const execution = z.object({
	data: z.record(z.string(), z.unknown()),
	error: z.string().nullable(),
	logId: z.string(),
})

interface ToolsProps {
	appId: string
	sessionToken: string
}

export class Tools extends WorkerEntrypoint<Bindings, ToolsProps> {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const env = parseEnv(this.env)
		const { appId, sessionToken } = this.ctx.props
		const response = await fetch(
			new URL(`/api/apps/${appId}/tools/call`, env.CTX_PLATFORM_URL),
			{
				body: JSON.stringify({ arguments: args, slug, tool: toolSlug }),
				headers: {
					"content-type": "application/json",
					cookie: `__Secure-ctx_viewer=${sessionToken}`,
				},
				method: "POST",
			},
		)
		if (!response.ok) throw new Error(`Tool call failed: HTTP ${response.status}`)
		const result = execution.parse(await response.json())
		if (result.error !== null) throw new Error(`${result.error} (log: ${result.logId})`)
		return { data: result.data, logId: result.logId }
	}
}
