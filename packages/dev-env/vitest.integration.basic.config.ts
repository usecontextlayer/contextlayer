import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: vitest.shared is at the monorepo root, outside this package — no @/ alias reaches it
import { basicIntegrationTestConfig } from "../../vitest.shared.ts"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineProject({
	resolve: { tsconfigPaths: true },
	test: {
		...basicIntegrationTestConfig,
		name: "@usecontextlayer/dev-env:integration:basic",
		root: projectRoot,
		// Allow for real Postgres round-trips and the web migration subprocess.
		testTimeout: 30_000,
	},
})
