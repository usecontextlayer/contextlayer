import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: { neverBundle: ["cloudflare:workers"] },
	dts: true,
	entry: {
		"app-connections": "lib/app-connections.ts",
		"app-resources": "lib/app-resources.ts",
		"app-usage": "lib/app-usage.ts",
		chrome: "lib/chrome.ts",
		connections: "lib/connections.ts",
		mcp: "lib/mcp.ts",
		"sentry-event-cap": "lib/sentry-event-cap.ts",
		slate: "lib/slate.ts",
		tools: "lib/tools.ts",
		"tools-worker": "lib/tools-worker.ts",
	},
	format: ["esm"],
	minify: false,
	outDir: "dist",
	platform: "node",
	sourcemap: false,
})
