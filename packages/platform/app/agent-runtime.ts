import { DurableObject } from "cloudflare:workers"
import assert from "node:assert/strict"
import { Composio } from "@composio/core"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare"
import {
	type ConversationId,
	type ConversationQuery,
	type Cursor,
	createRegistry,
	defineTool,
	type EntryQuery,
	Harness,
	type InputEntry,
	type SubmissionId,
	type UserInput,
} from "@earendil-works/pi-durable"
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env/remote"
import {
	databaseQuerySchema,
	databaseResultSchema,
} from "@usecontextlayer/shared/databases"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { type Schedule, Scheduler } from "agents/schedules"
import { z } from "zod"
import { createAccountSession } from "@/accounts.server"
import {
	COMPUTER_INACTIVITY_TIMEOUT_MS,
	createContainerConnection,
} from "@/agent-computer"
import { parseAgentInstanceName } from "@/agent-instance"
import { createAgentProvider } from "@/agent-provider"
import { createAgentTools } from "@/agent-tools"
import {
	type AgentActor,
	type AgentConfiguration,
	type AgentSchedule,
	type ScheduledAgentRun,
	scheduledAgentRunSchema,
} from "@/agents.schema"
import { getAgentConfiguration } from "@/agents.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import { parseDatabaseEnv } from "@/env"
import { loadSharedSecret } from "@/secrets.server"
import { slateSchema } from "@/slates.schema"

export class SlateAgent extends DurableObject<PlatformEnv["Bindings"]> {
	private lifecycle: Lifecycle<PlatformEnv["Bindings"]>
	private registry = createRegistry()
	private connectionSessions = new Map<
		string,
		Promise<Awaited<ReturnType<Composio["use"]>>>
	>()
	// Poll count, not time. Durable script deadlines use the @options timeout_ms field.
	private sandbox = createInlineCodemodeSandbox({ interruptBudget: 50_000 })
	private connection?: Connection
	private closeConnection = () => {
		this.connection?.close()
		this.connection = undefined
	}
	private scheduler = new Scheduler({
		callbacks: {
			runScheduled: (input: ScheduledAgentRun, schedule: Schedule<ScheduledAgentRun>) =>
				this.runScheduled(input, schedule),
		},
	})
	private harness = new PiHarness({
		defaults: { model: { id: "claude-haiku-4-5", provider: "anthropic" } },
		harness: async ({ storage, context, onWake }) => {
			const models = createModels()
			models.setProvider(
				createAgentProvider(
					this.env,
					this.env.MERIDIAN,
					async () => (await this.configuration()).secrets,
				),
			)
			this.registry.install(CodingTools)
			this.registry.install({
				name: "contextlayer",
				sections: [
					{
						key: "slate_instructions",
						render: async () => {
							const configuration = await this.configuration()
							const sections = [configuration.agent.instructions]
							const databases = Object.keys(configuration.databases)
							if (databases.length) {
								sections.push(
									`Declared databases: ${databases.join(", ")}. Database writes persist and are shared with the app and other conversations using that resource. Files on the computer are scratch space.`,
								)
							}
							const connections = Object.entries(configuration.connections)
							if (connections.length) {
								sections.push(
									`Connections:\n${connections.map(([name, { toolkit }]) => `- ${name}: ${toolkit}`).join("\n")}`,
								)
							}
							return sections.join("\n\n")
						},
					},
				],
				tools: [
					defineTool({
						description:
							"Execute parameterized SQL against a declared database. Read its schema with sqlite_master or PRAGMA table_info. Writes persist immediately.",
						execute: async ({
							slug,
							sql,
							params,
						}: z.input<typeof databaseQuerySchema>) => {
							const database = (await this.configuration()).databases[slug]
							if (!database) throw new Error("not-declared")
							const result = databaseResultSchema.parse(
								await this.env.DATABASES.getByName(database.instance_name).query(
									sql,
									params,
								),
							)
							return {
								output: [{ text: JSON.stringify(result), type: "text" }],
								structuredOutput: result,
							}
						},
						name: "database_query",
						parameters: z.toJSONSchema(databaseQuerySchema, { io: "input" }),
						structuredOutputSchema: z.toJSONSchema(databaseResultSchema),
					}),
				],
			})
			const prepared = await this.prepareConfiguration()
			await this.installConnectionTools(
				prepared.allowed ? prepared.configuration.connections : {},
			)
			const pi = await Harness.open(
				storage,
				{
					env: ({ cwd }) => {
						if (!this.connection) {
							assert(this.ctx.container)
							this.connection = createContainerConnection(this.ctx.container)
							void pi
								.waitForIdle(context)
								.then(this.closeConnection, this.closeConnection)
						}
						return new RemoteExecutionEnv({
							connection: this.connection,
							cwd: cwd ?? "/workspace",
							id: this.ctx.id.toString(),
						})
					},
					models,
					onWake,
					registry: this.registry,
				},
				context,
			)
			return pi
		},
	})

	constructor(ctx: DurableObjectState, env: PlatformEnv["Bindings"]) {
		super(ctx, env)
		const container = ctx.container
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() =>
				container.setInactivityTimeout(COMPUTER_INACTIVITY_TIMEOUT_MS),
			)
		}
		this.lifecycle = Lifecycle.install(this)
			.use({
				dispose: async () => {
					this.closeConnection()
					await ctx.container?.destroy()
				},
			})
			.use({ dispose: () => this.sandbox.close() })
			.use(this.harness)
			.use(this.scheduler)
	}

	private async prepareConfiguration() {
		assert(this.ctx.id.name)
		const { slateId, name, actor } = parseAgentInstanceName(this.ctx.id.name)
		const config = parseDatabaseEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const slate = slateSchema.parse(
				await db
					.selectFrom("slate")
					.selectAll()
					.where("id", "=", slateId)
					.executeTakeFirstOrThrow(),
			)
			return await getAgentConfiguration(
				db,
				this.env.ARTIFACTS,
				this.env.MEMBER_PROVISIONING,
				this.env,
				slate,
				actor,
				name,
			)
		} finally {
			await db.destroy()
		}
	}

	private async configuration() {
		const prepared = await this.prepareConfiguration()
		if (!prepared.allowed) {
			throw new Error(
				prepared.reason === "secret-required"
					? `secret-required: ${prepared.name}`
					: prepared.reason === "connection-required"
						? `connection-required: ${prepared.slug}`
						: prepared.reason,
			)
		}
		return prepared.configuration
	}

	private async installConnectionTools(connections: AgentConfiguration["connections"]) {
		const { extension, namespaces } = await createAgentTools(
			this.env.COMPOSIO_API_KEY,
			await Promise.all(
				Object.entries(connections).map(async ([name, connection]) => ({
					name,
					session: await this.connectionSession(connection),
					toolkit: connection.toolkit,
				})),
			),
			async (name, toolkit) => {
				const connection = (await this.configuration()).connections[name]
				if (!connection || connection.toolkit !== toolkit) throw new Error("not-declared")
				return this.connectionSession(connection)
			},
		)
		this.registry.install(extension)
		this.registry.install(createCodemodeExtension({ namespaces, sandbox: this.sandbox }))
	}

	private connectionSession(connection: AgentConfiguration["connections"][string]) {
		const { owner, toolkit, account_id } = connection
		const key = JSON.stringify([
			"composio-session",
			owner.type,
			owner.id,
			toolkit,
			account_id,
		])
		let pending = this.connectionSessions.get(key)
		if (!pending) {
			pending = (async () => {
				const id = await this.ctx.storage.get<string>(key)
				if (id) return new Composio({ apiKey: this.env.COMPOSIO_API_KEY }).use(id)
				const session = await createAccountSession(
					this.env.COMPOSIO_API_KEY,
					owner,
					account_id,
					toolkit,
				)
				await this.ctx.storage.put(key, session.sessionId)
				return session
			})()
			this.connectionSessions.set(key, pending)
			void pending.catch(() => this.connectionSessions.delete(key))
		}
		return pending
	}

	async createConversation(configuration: AgentConfiguration) {
		await this.lifecycle.start()
		const modelOwner = configuration.secrets.ANTHROPIC_MODEL
		const model = modelOwner
			? await loadSharedSecret(this.env, modelOwner, "ANTHROPIC_MODEL")
			: undefined
		const session = await this.harness.sessions.create()
		if (model !== undefined) await session.setModel({ id: model, provider: "anthropic" })
		const pi = await this.harness.pi()
		const conversation = await pi.commit(
			(tx) => tx.conversation(Number(session.id) as ConversationId),
			BACKGROUND_CONTEXT,
		)
		assert(conversation)
		return conversation
	}

	async submit(
		id: ConversationId,
		input: { content: UserInput; requestId?: string },
		configuration: AgentConfiguration,
	): Promise<unknown> {
		await this.lifecycle.start()
		return this.submitInput(id, input, configuration)
	}

	private async submitInput(
		id: ConversationId,
		input: { content: UserInput; requestId?: string },
		configuration: AgentConfiguration,
		entry?: InputEntry,
	) {
		const pi = await this.harness.pi()
		if (!(await pi.conversation(id, BACKGROUND_CONTEXT))) return undefined
		await this.installConnectionTools(configuration.connections)
		const receipt = await this.harness.session(String(id)).submit(input.content, {
			entry,
			operationId: input.requestId,
		})
		return pi.commit(
			(tx) => tx.submissionByRequest(id, receipt.operationId),
			BACKGROUND_CONTEXT,
		)
	}

	async getSubmission(id: SubmissionId): Promise<unknown> {
		await this.lifecycle.start()
		const submission = await (await this.harness.pi()).submission(id, BACKGROUND_CONTEXT)
		return submission?.status(BACKGROUND_CONTEXT)
	}

	async listConversations(
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<unknown> {
		await this.lifecycle.start()
		return (await this.harness.pi()).commit(
			(tx) => tx.scanConversations(query, limit, cursor),
			BACKGROUND_CONTEXT,
		)
	}

	async getConversation(id: ConversationId): Promise<unknown> {
		await this.lifecycle.start()
		const conversation = await (await this.harness.pi()).conversation(
			id,
			BACKGROUND_CONTEXT,
		)
		if (!conversation) return undefined
		const watch = await conversation.watch(BACKGROUND_CONTEXT)
		const view = watch.value
		await watch.stop()
		return view
	}

	async entries(
		id: ConversationId,
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor?: Cursor,
	): Promise<unknown> {
		await this.lifecycle.start()
		const conversation = await (await this.harness.pi()).conversation(
			id,
			BACKGROUND_CONTEXT,
		)
		return conversation?.entries(query, limit, cursor, BACKGROUND_CONTEXT)
	}

	async listAuthoredSchedules() {
		await this.lifecycle.start()
		return (await this.scheduler.list()).filter(
			(schedule) => schedule.callback === "runScheduled",
		)
	}

	async getAuthoredSchedule(id: string) {
		await this.lifecycle.start()
		const schedule = await this.scheduler.get(id)
		return schedule?.callback === "runScheduled" ? schedule : null
	}

	async provisionSchedules(
		slateId: SlateId,
		name: string,
		actor: AgentActor,
		schedules: AgentSchedule[],
	) {
		await this.lifecycle.start()
		for (const schedule of await this.listAuthoredSchedules()) {
			await this.scheduler.cancel(schedule.id)
		}
		for (const schedule of schedules) {
			await this.scheduler.set(schedule.cron, "runScheduled", {
				actor,
				name,
				prompt: schedule.prompt,
				schedule: schedule.name,
				slateId,
			})
		}
	}

	private async runScheduled(
		input: ScheduledAgentRun,
		schedule: Schedule<ScheduledAgentRun>,
	) {
		const scheduled = scheduledAgentRunSchema.parse(input)
		const prepared = await this.prepareConfiguration()
		if (!prepared.allowed && prepared.reason === "agent-definition-missing") {
			await this.provisionSchedules(
				scheduled.slateId,
				scheduled.name,
				scheduled.actor,
				[],
			)
			return
		}
		if (!prepared.allowed) {
			throw new Error(
				prepared.reason === "secret-required"
					? `secret-required: ${prepared.name}`
					: prepared.reason === "connection-required"
						? `connection-required: ${prepared.slug}`
						: prepared.reason,
			)
		}
		const conversation = await this.createConversation(prepared.configuration)
		await this.submitInput(
			conversation.id,
			{ content: scheduled.prompt },
			prepared.configuration,
			{
				data: { schedule: scheduled.schedule, scheduleId: schedule.id },
				kind: "slate.schedule",
			},
		)
	}
}
