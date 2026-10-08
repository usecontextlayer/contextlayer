import { WorkerEntrypoint } from "cloudflare:workers"
import { databaseResultSchema, type SqlValue } from "@/lib/databases"
import {
	type HostedExecution,
	readHostedExecutionResult,
	type ToolsProps,
} from "@/lib/tools-worker"

export class Databases extends WorkerEntrypoint<
	{ EXECUTION: HostedExecution },
	ToolsProps
> {
	async query(slug: string, sql: string, params: SqlValue[] = []) {
		const { appId, credential } = this.ctx.props
		const result = await this.env.EXECUTION.queryDatabase(appId, credential.token, {
			params,
			slug,
			sql,
		})
		return databaseResultSchema.parse(readHostedExecutionResult(result))
	}
}
