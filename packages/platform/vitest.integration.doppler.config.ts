import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { dopplerIntegrationTestInclude } from "../../vitest.shared.ts"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the app alias.
import basicIntegration from "./vitest.integration.basic.config.ts"

export default defineConfig({
	...basicIntegration,
	test: {
		...basicIntegration.test,
		include: dopplerIntegrationTestInclude,
		name: "@usecontextlayer/platform:integration:doppler",
	},
})
