import { WorkerEntrypoint } from "cloudflare:workers"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"
import type { Tools as ToolsContract } from "@/index"
import { userSchema, type Viewer as ViewerContract } from "@/viewer"

const execution = z.object({
	data: z.record(z.string(), z.unknown()),
	error: z.string().nullable(),
	logId: z.string(),
})

export class Tools extends WorkerEntrypoint<Bindings> implements ToolsContract {
	async call(slug: string, toolSlug: string, args: Record<string, unknown>) {
		const env = parseEnv(this.env)
		const response = await fetch(
			new URL(`/api/apps/${env.CTX_APP_ID}/tools/call`, env.CTX_PLATFORM_URL),
			{
				body: JSON.stringify({
					arguments: args,
					manifest: env.CTX_APP_MANIFEST,
					slug,
					tool: toolSlug,
				}),
				headers: {
					authorization: `Bearer ${env.CTX_ACCESS_TOKEN}`,
					"content-type": "application/json",
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

export class Viewer extends WorkerEntrypoint<Bindings> implements ViewerContract {
	async getCurrentUser() {
		const env = parseEnv(this.env)
		const response = await fetch(new URL("/api/me", env.CTX_AUTH_ISSUER), {
			headers: { authorization: `Bearer ${env.CTX_ACCESS_TOKEN}` },
		})
		if (response.status === 401) return null
		if (!response.ok) throw new Error(`Identity request failed: HTTP ${response.status}`)
		return userSchema.parse(await response.json())
	}
}
