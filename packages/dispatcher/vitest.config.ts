import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { unitTestExclude, unitTestInclude } from "../../vitest.shared.ts"

export default defineProject({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: unitTestExclude,
		include: unitTestInclude,
		name: "@usecontextlayer/dispatcher",
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
})
