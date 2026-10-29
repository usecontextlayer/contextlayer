import { test } from "@tests/integration"
import { getAgentByName } from "agents/routing"
import { expect } from "vitest"
import { getAgentInstanceName } from "@/agent-instance"
import { agentRunSchema } from "@/agents.schema"
import { startAgentRun } from "@/agents.server"

test("failed job admission leaves the catalog empty", async ({ platform }) => {
	const run = agentRunSchema.parse({
		actor: { type: "app" },
		agent: {
			commit: "admission-fixture",
			instructions: "Answer briefly.",
			name: "missing-model",
		},
		connections: {},
		databases: {},
		prompt: "Say hello.",
		secrets: {
			ANTHROPIC_MODEL: { id: crypto.randomUUID(), type: "personal" },
		},
		slateId: crypto.randomUUID(),
	})
	const { AGENTS } = await platform.worker.getEnv()
	await expect(startAgentRun(AGENTS, run)).rejects.toThrow()
	// Reacquire after rejected admission: a stub held across the failure can be invalid.
	const agent = await getAgentByName(
		AGENTS,
		getAgentInstanceName(run.slateId, run.agent.name, run.actor),
	)
	expect(await agent.listJobs()).toEqual([])
})
