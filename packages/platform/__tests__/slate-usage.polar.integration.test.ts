import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { test } from "@tests/integration"
import seed from "@usecontextlayer/dev-env/seed.json" with { type: "json" }
import { recordSlateUsage } from "@usecontextlayer/shared/slate-usage"
import { expect } from "vitest"

test("Polar acknowledges a reported slate tool call", async ({ serviceEnv }) => {
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	const result = await recordSlateUsage(
		polar,
		{ id: crypto.randomUUID(), owner: { id: seed.web.user.id, type: "personal" } },
		"tool_call",
	)
	expect(result).toEqual({ duplicates: 0, inserted: 1 })
})
