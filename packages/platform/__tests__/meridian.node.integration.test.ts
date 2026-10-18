import assert from "node:assert/strict"
import { createModels } from "@earendil-works/pi-ai/models"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { createAgentProvider } from "@/agent-provider"
import type { AgentRun } from "@/agents.schema"

test("subscription routing rejects an unknown Owner and declared API access takes precedence", async ({
	platform,
}) => {
	const { MERIDIAN } = await platform.worker.getEnv()
	const owner = { id: crypto.randomUUID(), type: "personal" } as const
	let secrets: AgentRun["secrets"] = { CLAUDE_CODE_OAUTH_TOKEN: owner }
	const models = createModels()
	models.setProvider(
		createAgentProvider(platform.env, MERIDIAN, () => secrets, crypto.randomUUID()),
	)
	const model = models.getModel("anthropic", "claude-haiku-4-5")
	assert(model)
	const result = await models
		.streamSimple(model, {
			messages: [{ content: "Say hello.", role: "user", timestamp: Date.now() }],
		})
		.result()
	expect(result.stopReason).toBe("error")
	expect(result.errorMessage).toContain("authentication_error")
	secrets = { ...secrets, ANTHROPIC_API_KEY: owner }
	await expect(models.getAuth(model)).rejects.toThrow(
		"API key auth failed for provider anthropic",
	)
})
