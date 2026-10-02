import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	dts: false,
	entry: ["cli.ts"],
	format: ["esm"],
	outDir: "dist",
	platform: "node",
})
