import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { basicIntegrationTestInclude } from "../../vitest.shared.ts"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		include: basicIntegrationTestInclude,
		name: "@usecontextlayer/build:integration:basic",
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
})
