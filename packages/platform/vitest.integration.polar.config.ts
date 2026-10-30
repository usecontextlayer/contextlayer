import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { polarIntegrationTestInclude } from "../../vitest.shared.ts"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the app alias.
import basicIntegration from "./vitest.integration.basic.config.ts"

export default defineConfig({
	...basicIntegration,
	test: {
		...basicIntegration.test,
		// Polar Sandbox allows 100 requests per minute per organization and answers anything beyond
		// with a 429, which the SDK does not retry. Every provider poll in this lane inherits this
		// interval, so each costs 12 requests per minute; maxWorkers polling files at once, plus the
		// billing gate's background reads from every lane, must stay under the limit.
		expect: { poll: { interval: 5_000 } },
		include: polarIntegrationTestInclude,
		maxWorkers: 3,
		name: "@usecontextlayer/platform:integration:polar",
	},
})
