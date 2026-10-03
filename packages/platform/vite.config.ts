import { fileURLToPath } from "node:url"
import { cloudflare } from "@cloudflare/vite-plugin"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { reactRouterHonoServer } from "react-router-hono-server/dev"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		tailwindcss(),
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		reactRouterHonoServer({ runtime: "cloudflare" }),
		reactRouter(),
	],
	preview: { port: 3010 },
	resolve: { alias: { "@": fileURLToPath(new URL("./app", import.meta.url)) } },
	server: { port: 3010 },
})
