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
		scaffold: "scaffold.ts",
		vite: "vite.ts",
	},
	format: ["esm"],
	hooks: {
		"build:done": () => {
			// The image cache lockfile records this CLI's integrity and must not ship inside it.
			cpSync("templates", "dist/templates", {
				filter: (source) => source !== "templates/app/pnpm-lock.yaml",
				recursive: true,
			})
		},
	},
	outDir: "dist",
	platform: "node",
})
