import { cloudflare } from "@cloudflare/vite-plugin"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig(({ command }) => ({
	plugins: [
		cloudflare({
			auxiliaryWorkers: [
				{ configPath: "workers/local-tools/wrangler.jsonc", devOnly: true },
			],
			config:
				command === "serve"
					? {
							services: [
								{ binding: "TOOLS", entrypoint: "Tools", service: "ctx-local-tools" },
							],
						}
					: {},
			viteEnvironment: { name: "ssr" },
		}),
		tailwindcss(),
		reactRouter(),
	],
	resolve: { tsconfigPaths: true },
}))
