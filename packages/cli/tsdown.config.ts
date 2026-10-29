import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { execa } from "execa"
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
		"build:done": async () => {
			cpSync("templates", "dist/templates", { recursive: true })
			await execa(
				"pnpm",
				[
					"exec",
					"wrangler",
					"deploy",
					"--dry-run",
					"--config",
					"local-runtime/wrangler.jsonc",
					"--outdir",
					resolve("dist/local-runtime"),
				],
				{ stdio: "inherit" },
			)
			const config = JSON.parse(readFileSync("local-runtime/wrangler.jsonc", "utf8"))
			writeFileSync(
				"dist/local-runtime/wrangler.jsonc",
				JSON.stringify(
					{
						...config,
						containers: [
							{
								class_name: "SlateAgentJob",
								images: { workspace: { dockerfile: "Dockerfile" } },
								scheduling_policy: "durable_object",
							},
							{
								class_name: "Meridian",
								image: "Dockerfile.meridian",
								instance_type: "lite",
								max_instances: 1,
								scheduling_policy: "default",
							},
						],
						find_additional_modules: true,
						main: "index.js",
						no_bundle: true,
					},
					null,
					2,
				),
			)
			for (const name of ["Dockerfile", "Dockerfile.meridian"])
				cpSync(`../shared/assets/${name}`, `dist/local-runtime/${name}`)
		},
	},
	outDir: "dist",
	platform: "node",
})
