import { WorkerEntrypoint } from "cloudflare:workers"
import assert from "node:assert/strict"
import { ToolRouterSessionExecuteResponseSchema, ToolSchema } from "@composio/core"
import {
	AgentPreparation as SharedAgentPreparation,
	AgentResources as SharedAgentResources,
} from "@usecontextlayer/shared/agent-resources"
import { scheduledAgentRunSchema } from "@usecontextlayer/shared/agents"
import type { SqlValue } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import { MeridianProfiles as SharedMeridianProfiles } from "@usecontextlayer/shared/meridian"
import { callLocalTool } from "@usecontextlayer/shared/tools-worker"
import { z } from "zod"
import { type LocalBindings, readSnapshot } from "@/local-runtime/env"
import { prepareLocalAgentRun } from "@/local-runtime/preparation"
import { type LocalSnapshot, localAgentRunSchema } from "@/local-runtime/schema"

async function gatewayRequest(
	snapshot: LocalSnapshot,
	accountId: string,
	suffix: string,
	input: { toolkit: string; [key: string]: unknown },
	method = "POST",
) {
	assert(
		snapshot.gateway,
		"A connected account requires a signed-in developer and registered slate",
	)
	const url = new URL(
		`/api/accounts/${encodeURIComponent(accountId)}${suffix}`,
		snapshot.gateway.platformUrl,
	)
	const body = { ...input, slate_id: snapshot.gateway.slateId }
	if (method === "GET") {
		for (const [name, value] of Object.entries(body))
			url.searchParams.set(name, String(value))
	}
	const response = await fetch(url, {
		body: method === "GET" ? undefined : JSON.stringify(body),
		headers: {
			authorization: `Bearer ${snapshot.gateway.token}`,
			"content-type": "application/json",
		},
		method,
	})
	if (!response.ok)
		throw new Error(
			`Personal account capability failed: HTTP ${response.status}: ${await response.text()}`,
		)
	return response.json()
}

export class AgentResources extends SharedAgentResources<LocalBindings> {
	private get run() {
		return localAgentRunSchema.parse(this.ctx.props)
	}
	private connection(name: string) {
		const connection = this.run.connections[name]
		assert(connection, "not-declared")
		return connection
	}
	async createConnectionSession(name: string) {
		const { account_id, toolkit } = this.connection(name)
		const result = await gatewayRequest(readSnapshot(this.env), account_id, "/sessions", {
			toolkit,
		})
		return z.object({ session_id: z.string().min(1) }).parse(result).session_id
	}
	async connectionTools(name: string, sessionId: string) {
		const { account_id, toolkit } = this.connection(name)
		const result = await gatewayRequest(
			readSnapshot(this.env),
			account_id,
			`/sessions/${encodeURIComponent(sessionId)}/tools`,
			{ toolkit },
			"GET",
		)
		return ToolSchema.array().parse(result)
	}
	async executeConnectionTool(
		name: string,
		sessionId: string,
		tool: string,
		args: Record<string, unknown>,
	) {
		const { account_id, toolkit } = this.connection(name)
		const result = await gatewayRequest(
			readSnapshot(this.env),
			account_id,
			`/sessions/${encodeURIComponent(sessionId)}/tools/call`,
			{ arguments: args, tool, toolkit },
		)
		return ToolRouterSessionExecuteResponseSchema.parse(result)
	}
	async queryDatabase(slug: string, sql: string, params: SqlValue[] = []) {
		const database = this.run.databases[slug]
		assert(database, "not-declared")
		return this.env.DATABASE_STORAGE.getByName(database.instance_name).query(sql, params)
	}
	async loadSecret(name: string) {
		const reference = this.run.secrets[name]
		assert(reference, "not-declared")
		const value = readSnapshot(this.env).configuration.secrets[reference.ref]?.value
		assert(value !== undefined && value !== null, `secret-required: ${name}`)
		return value
	}
	async subscriptionProfile() {
		const reference = this.run.secrets.CLAUDE_CODE_OAUTH_TOKEN
		assert(reference, "Declare ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN")
		return subscriptionProfile(readSnapshot(this.env).scope, reference.ref)
	}
	async fetch(request: Request) {
		return this.env.MERIDIAN.getByName("shared").fetch(request)
	}
}

export class AgentPreparation extends SharedAgentPreparation<LocalBindings> {
	async prepare(input: unknown) {
		const scheduled = scheduledAgentRunSchema.parse(input)
		const snapshot = readSnapshot(this.env)
		assert(
			scheduled.slateId === snapshot.scope && scheduled.actor.type === "app",
			"forbidden",
		)
		return prepareLocalAgentRun(snapshot, scheduled.name, scheduled.prompt)
	}
}

export class AppDatabases extends WorkerEntrypoint<LocalBindings> {
	async query(slug: string, sql: string, params: SqlValue[] = []) {
		const { databases } = resourcesForConsumer(readSnapshot(this.env).configuration, {
			type: "app",
		})
		const database = databases[slug]
		assert(database, "not-declared")
		return this.env.DATABASE_STORAGE.getByName(database.instance_name).query(sql, params)
	}
}

export class Tools extends WorkerEntrypoint<LocalBindings> {
	async call(slug: string, tool: string, args: Record<string, unknown>) {
		const snapshot = readSnapshot(this.env)
		const { connections } = resourcesForConsumer(snapshot.configuration, { type: "app" })
		const connection = connections[slug]
		assert(connection, "not-declared")
		if (connection.account_id === null)
			return Response.json({ reason: "connection-required", slug }, { status: 409 })
		assert(snapshot.gateway)
		return callLocalTool(
			snapshot.gateway.platformUrl,
			{
				connections,
				credential: { token: snapshot.gateway.token, type: "access-token" },
				slateId: snapshot.gateway.slateId,
			},
			slug,
			tool,
			args,
		)
	}
}

async function subscriptionProfile(scope: string, ref: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([scope, ref])),
	)
	return Array.from(new Uint8Array(digest), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("")
}

export class MeridianProfiles extends SharedMeridianProfiles<LocalBindings> {
	async load() {
		const snapshot = readSnapshot(this.env)
		const oauthToken = snapshot.configuration.secrets.CLAUDE_CODE_OAUTH_TOKEN?.value
		return oauthToken === undefined || oauthToken === null
			? []
			: [
					{
						id: await subscriptionProfile(snapshot.scope, "CLAUDE_CODE_OAUTH_TOKEN"),
						oauthToken,
					},
				]
	}
}
