import { configDefaults, defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the app alias.
import nodeIntegration from "./vitest.integration.node.config.ts"

export default defineConfig({
	...nodeIntegration,
	test: {
		...nodeIntegration.test,
		exclude: configDefaults.exclude,
		include: ["**/billing-webhooks.node.integration.test.ts"],
		name: "@usecontextlayer/platform:integration:polar-webhooks",
	},
})
