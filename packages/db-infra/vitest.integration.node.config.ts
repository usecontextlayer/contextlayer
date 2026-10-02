import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: vitest.shared is at the monorepo root, outside this package — no @/ alias reaches it
import { nodeIntegrationTestInclude } from "../../vitest.shared.ts"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineProject({
	resolve: { tsconfigPaths: true },
	test: {
		// beforeAll/afterAll run the ephemeral-DB lifecycle, and CREATE/DROP
		// DATABASE queue behind parallel suites' churn — the vitest 10s hook
		// default flaked there (measured a 12s DROP stall under lane load).
		hookTimeout: 30_000,
		include: nodeIntegrationTestInclude,
		name: "@usecontextlayer/db-infra:integration:node",
		root: projectRoot,
		// Real CREATE/DROP DATABASE round-trips against the dev Postgres.
		testTimeout: 30_000,
	},
})
