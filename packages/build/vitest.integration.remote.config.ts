import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { remoteIntegrationTestInclude } from "../../vitest.shared.ts"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		include: remoteIntegrationTestInclude,
		name: "@usecontextlayer/build:integration:remote",
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
})
