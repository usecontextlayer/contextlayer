import { execFileSync } from "node:child_process"
import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	deps: { alwaysBundle: ["@usecontextlayer/shared"] },
	dts: true,
	entry: { auth: "auth-public.ts", cli: "cli.ts", vite: "vite.ts" },
	format: ["esm"],
	hooks: {
		"build:done": () => {
			execFileSync("tar", ["-czf", "dist/template.tar.gz", "template"], {
				env: { ...process.env, COPYFILE_DISABLE: "1" },
				stdio: "inherit",
			})
		},
	},
	outDir: "dist",
	platform: "node",
})
