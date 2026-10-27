import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		"database.ts",
		"dev-env.ts",
		"doppler.ts",
		"env.ts",
		"mcp.ts",
		"polar.ts",
		"ports.ts",
		"services.ts",
		"slate.ts",
		"viewer.ts",
		"web.ts",
	],
	format: ["esm"],
	outDir: "dist",
	platform: "node",
	sourcemap: true,
})
