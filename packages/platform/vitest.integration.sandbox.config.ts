import { defineConfig } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the package
import { sandboxIntegrationTestInclude } from "../../vitest.shared.ts"
// biome-ignore lint/style/noRestrictedImports: shared test configuration lives outside the app alias.
import basicIntegration from "./vitest.integration.basic.config.ts"

export default defineConfig({
	...basicIntegration,
	test: {
		...basicIntegration.test,
		include: sandboxIntegrationTestInclude,
		// Every file provisions databases in Build sandboxes, which share the Docker VM's CPUs. Beyond
		// three files at once the VM saturates and every sandbox's install and migration stretch together.
		maxWorkers: 3,
		name: "@usecontextlayer/platform:integration:sandbox",
	},
})
