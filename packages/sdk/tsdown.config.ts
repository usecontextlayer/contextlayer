import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: {
		alwaysBundle: ["@usecontextlayer/shared"],
		neverBundle: ["cloudflare:workers"],
	},
	dts: true,
	entry: {
		index: "index.ts",
		local: "local.ts",
		react: "react.tsx",
		vite: "vite.ts",
		worker: "worker.ts",
	},
	format: ["esm"],
	outDir: "dist",
	platform: "neutral",
})
