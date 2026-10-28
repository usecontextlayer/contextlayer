import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { nodeIntegrationTestInclude } from "../../vitest.shared.ts"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: [...configDefaults.exclude, "**/billing-webhooks.node.integration.test.ts"],
		fileParallelism: true,
		hookTimeout: 300_000,
		include: nodeIntegrationTestInclude,
		name: "@usecontextlayer/platform:integration:node",
		root: fileURLToPath(new URL(".", import.meta.url)),
		testTimeout: 90_000,
	},
})
