import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	copy: [{ from: "template", to: "dist" }],
	dts: true,
	entry: ["cli.ts", "vite.ts"],
	format: ["esm"],
	outDir: "dist",
	platform: "node",
})
