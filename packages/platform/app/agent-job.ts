import assert from "node:assert/strict"
import { Composio } from "@composio/core"
import { createModels } from "@earendil-works/pi-ai/models"
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare"
import { createRegistry, defineTool, Harness } from "@earendil-works/pi-durable"
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env/remote"
import {
	databaseQuerySchema,
	databaseResultSchema,
} from "@usecontextlayer/shared/databases"
import { Agent } from "agents"
import { PiHarness, type PiHarnessContext, type PiReceipt } from "agents/harness/pi"
import { z } from "zod"
import { createAccountSession } from "@/accounts.server"
import {
	COMPUTER_INACTIVITY_TIMEOUT_MS,
	createContainerConnection,
} from "@/agent-computer"
import { createAgentProvider } from "@/agent-provider"
import { createAgentTools } from "@/agent-tools"
import { type AgentRun, agentRunSchema } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import { loadSharedSecret } from "@/secrets.server"

export class SlateAgentJob extends Agent<
	PlatformEnv["Bindings"],
	{
		connectionSessions: Record<string, string>
		run: AgentRun | null
		receipt: PiReceipt | null
	}
> {
	initialState = { connectionSessions: {}, receipt: null, run: null }
	private piContext!: PiHarnessContext["context"]
	private registry = createRegistry()
	private sandbox = createInlineCodemodeSandbox({ interruptBudget: 50_000 })
	private connection?: Connection
	private closeConnection = () => {
		this.connection?.close()
		this.connection = undefined
	}

	private harness = new PiHarness({
		defaults: { model: { id: "claude-haiku-4-5", provider: "anthropic" } },
		harness: async ({ storage, context }) => {
			this.piContext = context
			const models = createModels()
			models.setProvider(
				createAgentProvider(
					this.env,
					this.env.MERIDIAN,
					() => this.run.secrets,
					this.name,
				),
			)
			this.registry.install(CodingTools)
			this.registry.install({
				name: "contextlayer",
				sections: [
					{
						key: "slate_instructions",
						render: () => this.run.agent.instructions,
					},
					{
						key: "databases",
						render: () => {
							const slugs = Object.keys(this.run.databases)
							return slugs.length === 0
								? undefined
								: `Declared databases: ${slugs.join(", ")}. Database writes persist and are shared with the app and other jobs using that resource. Files in the sandbox are scratch space.`
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
							const database = this.run.databases[slug]
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
			const composio = new Composio({ apiKey: this.env.COMPOSIO_API_KEY })
			await this.installConnectionTools(
				await Promise.all(
					Object.entries(this.state.run?.connections ?? {}).map(
						async ([name, { toolkit }]) => {
							const sessionId = this.state.connectionSessions[name]
							assert(sessionId)
							return { name, session: await composio.use(sessionId), toolkit }
						},
					),
				),
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
		this.lifecycle.use({
			dispose: async () => {
				this.closeConnection()
				await ctx.container?.destroy()
			},
		})
		this.lifecycle.use({ dispose: () => this.sandbox.close() })
		this.lifecycle.use(this.harness)
	}

	async start(input: AgentRun) {
		const run = agentRunSchema.parse(input)
		const connections: Parameters<typeof createAgentTools>[1] = []
		for (const [name, connection] of Object.entries(run.connections)) {
			const session = await createAccountSession(
				this.env.COMPOSIO_API_KEY,
				connection.owner,
				connection.account_id,
				connection.toolkit,
			)
			connections.push({ name, session, toolkit: connection.toolkit })
		}
		const connectionSessions = Object.fromEntries(
			connections.map(({ name, session }) => [name, session.sessionId]),
		)
		this.setState({ connectionSessions, receipt: null, run })
		await this.installConnectionTools(connections)
		const modelOwner = run.secrets.ANTHROPIC_MODEL
		if (modelOwner) {
			const id = await loadSharedSecret(this.env, modelOwner, "ANTHROPIC_MODEL")
			await this.harness.session().setModel({ id, provider: "anthropic" })
		}
		const receipt = await this.harness.submit(run.prompt)
		this.setState({ connectionSessions, receipt, run })
		return receipt
	}

	private async installConnectionTools(
		connections: Parameters<typeof createAgentTools>[1],
	) {
		const { extension, namespaces } = await createAgentTools(
			this.env.COMPOSIO_API_KEY,
			connections,
		)
		this.registry.install(extension)
		this.registry.install(createCodemodeExtension({ namespaces, sandbox: this.sandbox }))
	}

	private get run() {
		assert(this.state.run)
		return this.state.run
	}

	private get receipt() {
		assert(this.state.receipt)
		return this.state.receipt
	}

	async operation() {
		const { operationId, session } = this.receipt
		const pending = await this.harness.pending({ session })
		return (
			pending.find((operation) => operation.operationId === operationId) ??
			this.harness.wait(operationId, { session })
		)
	}

	async result() {
		const { operationId, session } = this.receipt
		return this.harness.wait(operationId, { session })
	}

	async abort() {
		const { operationId, session } = this.receipt
		return this.harness.abort({ operationId, session })
	}

	async listSessions() {
		return this.harness.sessions.list()
	}

	async messages(session: string): Promise<unknown> {
		const sessions = await this.harness.sessions.list()
		if (!sessions.some(({ id }) => id === session)) return null
		return this.harness.session(session).messages()
	}

	async usage() {
		return (await this.harness.pi()).usage(this.piContext)
	}

	async inspection(): Promise<unknown> {
		return (await this.harness.pi()).inspect(this.piContext)
	}
}
