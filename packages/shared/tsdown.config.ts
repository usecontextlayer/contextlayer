import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: { neverBundle: ["cloudflare:workers"] },
	dts: true,
	entry: {
		accounts: "lib/accounts.ts",
		chrome: "lib/chrome.ts",
		"database-dialect": "lib/database-dialect.ts",
		"database-worker": "lib/database-worker.ts",
		databases: "lib/databases.ts",
		"databases-worker": "lib/databases-worker.ts",
		declaration: "lib/declaration.ts",
		inspection: "lib/inspection.ts",
		mcp: "lib/mcp.ts",
		"slate-connections": "lib/slate-connections.ts",
		"slate-provisioning": "lib/slate-provisioning.ts",
		"slate-resources": "lib/slate-resources.ts",
		"slate-usage": "lib/slate-usage.ts",
		tools: "lib/tools.ts",
		"tools-worker": "lib/tools-worker.ts",
	},
	format: ["esm"],
	minify: false,
	outDir: "dist",
	platform: "node",
	sourcemap: false,
})
