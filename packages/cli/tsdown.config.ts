import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	copy: [{ from: "template", to: "dist" }],
	deps: { alwaysBundle: ["@usecontextlayer/shared"] },
	dts: true,
	entry: {
		auth: "auth-public.ts",
		cli: "cli.ts",
		database: "database.ts",
		vite: "vite.ts",
	},
	format: ["esm"],
	outDir: "dist",
	platform: "node",
})
