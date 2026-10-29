import assert from "node:assert/strict"
import { createModels } from "@earendil-works/pi-ai/models"
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare"
import { createRegistry, defineTool, Harness } from "@earendil-works/pi-durable"
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env/remote"
import { Agent } from "agents"
import { PiHarness, type PiHarnessContext, type PiReceipt } from "agents/harness/pi"
import { z } from "zod"
import {
	COMPUTER_INACTIVITY_TIMEOUT_MS,
	createContainerConnection,
} from "@/lib/agent-computer"
import { createAgentProvider } from "@/lib/agent-provider"
import type { AgentRuntimeExports } from "@/lib/agent-resources"
import { createAgentTools } from "@/lib/agent-tools"
import { type AgentRun, agentRunSchema } from "@/lib/agents"
import { databaseQuerySchema, databaseResultSchema } from "@/lib/databases"

export class SlateAgentJob extends Agent<
	object,
	{
		connectionSessions: Record<string, string>
		run: AgentRun | null
		receipt: PiReceipt | null
	}
> {
	initialState = { connectionSessions: {}, receipt: null, run: null }
	private piContext!: PiHarnessContext["context"]
	private registry = createRegistry()
	// Poll count, not time. Durable script deadlines use the @options timeout_ms field.
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
					() => this.resources,
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
							if (!Object.hasOwn(this.run.databases, slug))
								throw new Error("not-declared")
							const result = databaseResultSchema.parse(
								await this.resources.queryDatabase(slug, sql, params),
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
			await this.installConnectionTools()
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

	constructor(ctx: DurableObjectState, env: object) {
		super(ctx, env)
		const container = ctx.container
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() =>
				container.setInactivityTimeout(COMPUTER_INACTIVITY_TIMEOUT_MS),
			)
		}
		// Pi must finish disposal while its sandbox and computer are still available.
		this.lifecycle.use({
			dispose: async () => {
				this.closeConnection()
				await ctx.container?.destroy()
			},
		})
		this.lifecycle.use({ dispose: () => this.sandbox.close() })
		this.lifecycle.use(this.harness)
	}

	async start(run: AgentRun) {
		// Validation must retain the environment-owned references in the original run.
		agentRunSchema.parse(run)
		const resources = (this.ctx.exports as AgentRuntimeExports).AgentResources({
			props: run,
		})
		const connectionSessions: Record<string, string> = {}
		for (const name of Object.keys(run.connections)) {
			connectionSessions[name] = await resources.createConnectionSession(name)
		}
		this.setState({ connectionSessions, receipt: null, run })
		await this.installConnectionTools()
		if (Object.hasOwn(run.secrets, "ANTHROPIC_MODEL")) {
			const id = await resources.loadSecret("ANTHROPIC_MODEL")
			await this.harness.session().setModel({ id, provider: "anthropic" })
		}
		const receipt = await this.harness.submit(run.prompt)
		this.setState({ connectionSessions, receipt, run })
		return receipt
	}

	private async installConnectionTools() {
		const connections = await Promise.all(
			Object.entries(this.state.run?.connections ?? {}).map(
				async ([name, { toolkit }]) => {
					const resources = this.resources
					const sessionId = this.state.connectionSessions[name]
					assert(sessionId)
					return {
						actions: await resources.connectionTools(name, sessionId),
						execute: (tool: string, args: Record<string, unknown>) =>
							resources.executeConnectionTool(name, sessionId, tool, args),
						name,
						toolkit,
					}
				},
			),
		)
		const { extension, namespaces } = createAgentTools(connections)
		this.registry.install(extension)
		this.registry.install(createCodemodeExtension({ namespaces, sandbox: this.sandbox }))
	}

	private get resources() {
		return (this.ctx.exports as AgentRuntimeExports).AgentResources({
			props: this.run,
		})
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
