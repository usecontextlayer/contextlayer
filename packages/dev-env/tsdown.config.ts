import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		"database.ts",
		"development.ts",
		"doppler.ts",
		"env.ts",
		"mcp.ts",
		"polar.ts",
		"ports.ts",
		"services.ts",
		"viewer.ts",
		"web.ts",
	],
	format: ["esm"],
	outDir: "dist",
	platform: "node",
	sourcemap: true,
})
