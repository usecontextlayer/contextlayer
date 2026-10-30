import { cpSync } from "node:fs"
import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: { alwaysBundle: ["@usecontextlayer/shared"] },
	dts: true,
	entry: {
		auth: "auth-public.ts",
		cli: "cli.ts",
		database: "database.ts",
		vite: "vite.ts",
	},
	format: ["esm"],
	hooks: {
		"build:done": () => {
			cpSync("templates", "dist/templates", { recursive: true })
		},
	},
	outDir: "dist",
	platform: "node",
})
