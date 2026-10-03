import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: { neverBundle: ["cloudflare:workers"] },
	dts: true,
	entry: { index: "index.ts", local: "local.ts" },
	format: ["esm"],
	outDir: "dist",
	platform: "neutral",
})
