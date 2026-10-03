import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	copy: [{ from: "template", to: "dist" }],
	dts: false,
	entry: ["cli.ts"],
	format: ["esm"],
	outDir: "dist",
	platform: "node",
})
