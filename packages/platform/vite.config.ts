import { fileURLToPath } from "node:url"
import { cloudflare } from "@cloudflare/vite-plugin"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { reactRouterHonoServer } from "react-router-hono-server/dev"
import { defineConfig } from "vite"

export default defineConfig(({ mode }) => ({
	plugins: [
		tailwindcss(),
		cloudflare({
			auxiliaryWorkers: [
				{
					configPath: fileURLToPath(new URL("../build/wrangler.jsonc", import.meta.url)),
					devOnly: true,
				},
			],
			config:
				mode === "test"
					? { compatibility_flags: ["no_nodejs_global_timers"] }
					: undefined,
			inspectorPort: 0,
			viteEnvironment: { name: "ssr" },
		}),
		reactRouterHonoServer({ runtime: "cloudflare" }),
		reactRouter(),
	],
	preview: { port: 3010 },
	resolve: { tsconfigPaths: true },
	server: { port: 3010 },
}))
