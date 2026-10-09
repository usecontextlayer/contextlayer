import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { test } from "@tests/integration"
import { recordAppUsage } from "@usecontextlayer/shared/app-usage"
import { expect } from "vitest"

test("Polar acknowledges a reported app tool call", async ({ identity, serviceEnv }) => {
	const polar = createPolarCore({
		accessToken: serviceEnv.polarEnv.POLAR_ACCESS_TOKEN,
		environment: serviceEnv.polarEnv.POLAR_ENVIRONMENT,
	})
	const result = await recordAppUsage(
		polar,
		{ id: crypto.randomUUID(), owner: { id: identity.user.id, type: "user" } },
		"tool_call",
	)
	expect(result).toEqual({ duplicates: 0, inserted: 1 })
})
