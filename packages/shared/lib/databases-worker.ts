import { WorkerEntrypoint } from "cloudflare:workers"
import { databaseResultSchema, type SqlValue } from "@/lib/databases"
import type { HostedExecution, ToolsProps } from "@/lib/tools-worker"

export class Databases extends WorkerEntrypoint<
	{ EXECUTION: HostedExecution },
	ToolsProps
> {
	async query(slug: string, sql: string, params: SqlValue[] = []) {
		const { appId, credential } = this.ctx.props
		const response = await this.env.EXECUTION.queryDatabase(appId, credential.token, {
			params,
			slug,
			sql,
		})
		if (!response.ok) throw new Error(`Database query failed: HTTP ${response.status}`)
		return databaseResultSchema.parse(await response.json())
	}
}
