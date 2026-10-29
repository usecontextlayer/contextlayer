import { WorkerEntrypoint } from "cloudflare:workers"
import type { Tool, ToolRouterSessionExecuteResponse } from "@composio/core"
import type { AgentRun, ScheduledAgentRun } from "@/lib/agents"
import type { DatabaseResult, SqlValue } from "@/lib/databases"

export abstract class AgentResources<Env = unknown> extends WorkerEntrypoint<
	Env,
	AgentRun
> {
	abstract createConnectionSession(name: string): Promise<string>
	abstract connectionTools(name: string, sessionId: string): Promise<Tool[]>
	abstract executeConnectionTool(
		name: string,
		sessionId: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<ToolRouterSessionExecuteResponse>
	abstract queryDatabase(
		slug: string,
		sql: string,
		params?: SqlValue[],
	): Promise<DatabaseResult>
	abstract loadSecret(name: string): Promise<string>
	abstract subscriptionProfile(): Promise<string>
	abstract fetch(request: Request): Promise<Response>
}

export type AgentRunPreparation =
	| { allowed: true; run: AgentRun }
	| { allowed: false; reason: "agent-definition-missing" | "forbidden" | "no-commit" }
	| { allowed: false; reason: "secret-required"; name: string }
	| { allowed: false; reason: "connection-required"; slug: string }

export abstract class AgentPreparation<Env = unknown> extends WorkerEntrypoint<Env> {
	abstract prepare(input: ScheduledAgentRun): Promise<AgentRunPreparation>
}

export type AgentRuntimeExports = {
	AgentResources: LoopbackServiceStub<AgentResources>
	AgentPreparation: Pick<AgentPreparation, "prepare">
}
