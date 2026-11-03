import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import * as integration from "../../vitest.shared.ts"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		...integration.platformIntegrationTestConfig,
		...integration.remoteIntegrationTestConfig,
		name: "@usecontextlayer/platform:integration:remote",
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
})
