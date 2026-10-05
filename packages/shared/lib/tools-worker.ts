import { WorkerEntrypoint } from "cloudflare:workers"
import { z } from "zod"
import type { Slate } from "@/lib/slate"

export interface ToolsProps {
	appId: string
	credential: { token: string; type: "access-token" | "session" }
	manifest?: Slate
}

const execution = z.object({
	data: z.record(z.string(), z.unknown()),
	error: z.string().nullable(),
	logId: z.string(),
})

export class Tools extends WorkerEntrypoint<{ CTX_PLATFORM_URL: string }, ToolsProps> {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const { appId, credential, manifest } = this.ctx.props
		const response = await fetch(
			new URL(`/api/apps/${appId}/tools/call`, this.env.CTX_PLATFORM_URL),
			{
				body: JSON.stringify({ arguments: args, manifest, slug, tool: toolSlug }),
				headers: {
					"content-type": "application/json",
					...(credential.type === "access-token"
						? { authorization: `Bearer ${credential.token}` }
						: { cookie: `ctx-viewer-auth=${credential.token}` }),
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
