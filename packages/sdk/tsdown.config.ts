import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: { neverBundle: ["cloudflare:workers", /\?(inline|url)$/] },
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
