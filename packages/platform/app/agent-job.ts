import { createModels } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { ownerSchema } from "@usecontextlayer/shared/slate-usage"
import { Agent } from "agents"
import { PiHarness } from "agents/harness/pi"
import { type AgentRun, agentRunSchema } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import { loadSharedSecret } from "@/secrets.server"

export class SlateAgentJob extends Agent<
	PlatformEnv["Bindings"],
	{ run: AgentRun | null }
> {
	initialState = { run: null }

	private harness = new PiHarness({
		defaults: { model: { id: "claude-haiku-4-5", provider: "anthropic" } },
		harness: ({ storage, context }) => {
			const models = createModels({
				authContext: {
					env: async (name) => {
						if (name !== "ANTHROPIC_API_KEY") return undefined
						const run = agentRunSchema.parse(this.state.run)
						return loadSharedSecret(
							this.env,
							ownerSchema.parse(run.secrets.ANTHROPIC_API_KEY),
							name,
						)
					},
					fileExists: async () => false,
				},
			})
			models.setProvider(anthropicProvider())
			const registry = createRegistry()
			registry.install({
				name: "contextlayer",
				sections: [
					{
						key: "slate_instructions",
						render: () => agentRunSchema.parse(this.state.run).agent.instructions,
					},
				],
			})
			return Harness.open(storage, { models, registry }, context)
		},
	})

	constructor(ctx: DurableObjectState, env: PlatformEnv["Bindings"]) {
		super(ctx, env)
		this.lifecycle.use(this.harness)
	}

	async start(input: AgentRun, operationId: string) {
		const run = agentRunSchema.parse(input)
		this.setState({ run })
		return this.harness.submit(run.prompt, { operationId })
	}

	async inspect(operationId: string) {
		const [pending] = await this.harness.pending()
		return pending ?? this.harness.wait(operationId)
	}

	async result(operationId: string) {
		return this.harness.wait(operationId)
	}

	async abort(operationId: string) {
		return this.harness.abort({ operationId })
	}
}
