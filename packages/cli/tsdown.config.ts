import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	copy: [{ from: "template", to: "dist" }],
	deps: { alwaysBundle: ["@usecontextlayer/shared"] },
	dts: true,
	entry: ["cli.ts", "vite.ts"],
	format: ["esm"],
	outDir: "dist",
	platform: "node",
})
