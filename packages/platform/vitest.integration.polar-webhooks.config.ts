import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { polarWebhooksIntegrationTestInclude } from "../../vitest.shared.ts"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the app alias.
import basicIntegration from "./vitest.integration.basic.config.ts"

export default defineConfig({
	...basicIntegration,
	test: {
		...basicIntegration.test,
		include: polarWebhooksIntegrationTestInclude,
		name: "@usecontextlayer/platform:integration:polar-webhooks",
	},
})
