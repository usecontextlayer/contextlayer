import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: {
		alwaysBundle: ["@usecontextlayer/shared"],
		neverBundle: ["cloudflare:workers"],
	},
	dts: true,
	entry: {
		"database-cli": "database-cli.ts",
		html: "html.ts",
		index: "index.ts",
		react: "react.tsx",
		vite: "vite.ts",
		worker: "worker.ts",
	},
	format: ["esm"],
	outDir: "dist",
	platform: "neutral",
})
