import { contextlayer } from "@contextlayer/sdk/vite"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig((env) => ({
	plugins: [contextlayer(env), tailwindcss(), reactRouter()],
	resolve: { tsconfigPaths: true },
}))
