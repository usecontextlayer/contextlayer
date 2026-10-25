import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: vitest.shared is at the monorepo root, outside this package — no @/ alias reaches it
import { nodeIntegrationTestInclude } from "../../vitest.shared.ts"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineProject({
	resolve: { tsconfigPaths: true },
	test: {
		include: nodeIntegrationTestInclude,
		name: "@usecontextlayer/dev-env:integration:node",
		root: projectRoot,
		// Real CREATE/DROP DATABASE round-trips against the dev Postgres.
		testTimeout: 30_000,
	},
})
