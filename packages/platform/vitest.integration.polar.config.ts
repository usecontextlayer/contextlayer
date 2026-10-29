import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { polarIntegrationTestInclude } from "../../vitest.shared.ts"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the app alias.
import basicIntegration from "./vitest.integration.basic.config.ts"

export default defineConfig({
	...basicIntegration,
	test: {
		...basicIntegration.test,
		include: polarIntegrationTestInclude,
		// Polar Sandbox allows 100 requests per minute per organization, and one file's 1-second
		// provider poll already uses 60, so two files polling at once exceed the limit.
		maxWorkers: 1,
		name: "@usecontextlayer/platform:integration:polar",
	},
})
