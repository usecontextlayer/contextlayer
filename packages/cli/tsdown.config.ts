import { execFileSync } from "node:child_process"
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
			// The image cache lockfile records the CLI's integrity and cannot ship inside that same CLI.
			execFileSync(
				"tar",
				["--exclude=template/pnpm-lock.yaml", "-czf", "dist/template.tar.gz", "template"],
				{
					env: { ...process.env, COPYFILE_DISABLE: "1" },
					stdio: "inherit",
				},
			)
		},
	},
	outDir: "dist",
	platform: "node",
})
