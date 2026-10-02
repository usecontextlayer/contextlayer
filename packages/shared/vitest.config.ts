import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: vitest.shared is at the monorepo root, outside this package — no @/ alias reaches it
import { unitTestExclude, unitTestInclude } from "../../vitest.shared.ts"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineProject({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: unitTestExclude,
		include: unitTestInclude,
		name: "@usecontextlayer/shared",
		root: projectRoot,
	},
})
