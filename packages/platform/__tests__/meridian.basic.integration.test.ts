import assert from "node:assert/strict"
import { createModels } from "@earendil-works/pi-ai/models"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { createAgentProvider } from "@/agent-provider"
import type { AgentRun } from "@/agents.schema"

test("declared API access fails without falling back to subscription access", async ({
	platform,
}) => {
	const { MERIDIAN } = await platform.worker.getEnv()
	const owner = { id: crypto.randomUUID(), type: "personal" } as const
	const secrets: AgentRun["secrets"] = {
		ANTHROPIC_API_KEY: owner,
		CLAUDE_CODE_OAUTH_TOKEN: owner,
	}
	const models = createModels()
	models.setProvider(
		createAgentProvider(platform.env, MERIDIAN, () => secrets, crypto.randomUUID()),
	)
	const model = models.getModel("anthropic", "claude-haiku-4-5")
	assert(model)
	await expect(models.getAuth(model)).rejects.toThrow(
		"API key auth failed for provider anthropic",
	)
})
