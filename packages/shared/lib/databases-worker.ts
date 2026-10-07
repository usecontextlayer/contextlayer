import { WorkerEntrypoint } from "cloudflare:workers"
import { databaseResultSchema, type SqlValue } from "@/lib/databases"
import type { ToolsProps } from "@/lib/tools-worker"

export class Databases extends WorkerEntrypoint<
	{ CTX_PLATFORM_URL: string },
	ToolsProps
> {
	async query(slug: string, sql: string, params: SqlValue[] = []) {
		const { appId, credential } = this.ctx.props
		const response = await fetch(
			new URL(`/api/apps/${appId}/databases/query`, this.env.CTX_PLATFORM_URL),
			{
				body: JSON.stringify({ params, slug, sql }),
				headers: {
					"content-type": "application/json",
					cookie: `ctx-viewer-auth=${credential.token}`,
				},
				method: "POST",
			},
		)
		if (!response.ok) throw new Error(`Database query failed: HTTP ${response.status}`)
		return databaseResultSchema.parse(await response.json())
	}
}
