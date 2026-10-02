import { fileURLToPath } from "node:url"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { reactRouterHonoServer } from "react-router-hono-server/dev"
import { defineConfig } from "vite"

export default defineConfig({
	base: "/dashboard/",
	plugins: [tailwindcss(), reactRouterHonoServer(), reactRouter()],
	resolve: { alias: { "@": fileURLToPath(new URL("./app", import.meta.url)) } },
})
