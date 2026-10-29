import assert from "node:assert/strict"
import { Composio } from "@composio/core"
import {
	AgentPreparation as SharedAgentPreparation,
	AgentResources as SharedAgentResources,
} from "@usecontextlayer/shared/agent-resources"
import type { ScheduledAgentRun } from "@usecontextlayer/shared/agents"
import type { SqlValue } from "@usecontextlayer/shared/databases"
import { createAccountSession } from "@/accounts.server"
import { agentRunSchema, scheduledAgentRunSchema } from "@/agents.schema"
import { getAgentRun } from "@/agents.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parsePlatformEnv } from "@/env"
import { loadSharedSecret, secretKey, secretKeyRef } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

export class AgentResources extends SharedAgentResources<PlatformEnv["Bindings"]> {
	private get run() {
		return agentRunSchema.parse(this.ctx.props)
	}

	async createConnectionSession(name: string) {
		const connection = this.run.connections[name]
		assert(connection, "not-declared")
		const session = await createAccountSession(
			this.env.COMPOSIO_API_KEY,
			connection.owner,
			connection.account_id,
			connection.toolkit,
		)
		return session.sessionId
	}

	async connectionTools(name: string, sessionId: string) {
		assert(Object.hasOwn(this.run.connections, name), "not-declared")
		return new Composio({
			apiKey: this.env.COMPOSIO_API_KEY,
		}).tools.getRawToolRouterSessionTools(sessionId)
	}

	async executeConnectionTool(
		name: string,
		sessionId: string,
		tool: string,
		args: Record<string, unknown>,
	) {
		assert(Object.hasOwn(this.run.connections, name), "not-declared")
		const session = await new Composio({ apiKey: this.env.COMPOSIO_API_KEY }).use(
			sessionId,
		)
		return session.execute(tool, args)
	}

	async queryDatabase(slug: string, sql: string, params?: SqlValue[]) {
		const database = this.run.databases[slug]
		if (!database) throw new Error("not-declared")
		return this.env.DATABASES.getByName(database.instance_name).query(sql, params)
	}

	async loadSecret(name: string) {
		const owner = this.run.secrets[name]
		assert(owner, "not-declared")
		return loadSharedSecret(this.env, owner, name)
	}

	async subscriptionProfile() {
		const owner = this.run.secrets.CLAUDE_CODE_OAUTH_TOKEN
		assert(owner, "Declare ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN")
		return secretKeyRef(secretKey(owner, "CLAUDE_CODE_OAUTH_TOKEN"))
	}

	async fetch(request: Request) {
		return this.env.MERIDIAN.getByName("shared").fetch(request)
	}
}

export class AgentPreparation extends SharedAgentPreparation<PlatformEnv["Bindings"]> {
	async prepare(input: ScheduledAgentRun) {
		const scheduled = scheduledAgentRunSchema.parse(input)
		const config = parsePlatformEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const slate = slateSchema.parse(
				await db
					.selectFrom("slate")
					.selectAll()
					.where("id", "=", scheduled.slateId)
					.executeTakeFirstOrThrow(),
			)
			return await getAgentRun(
				db,
				this.env.ARTIFACTS,
				this.env.MEMBER_PROVISIONING,
				config,
				slate,
				scheduled.actor,
				scheduled,
			)
		} finally {
			await db.destroy()
		}
	}
}
