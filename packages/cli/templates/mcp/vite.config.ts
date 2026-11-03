import { contextlayer } from "@usecontextlayer/sdk/vite"
import { defineConfig } from "vite"

export default defineConfig((env) => ({
	build: { outDir: "build" },
	plugins: [contextlayer(env)],
	resolve: { tsconfigPaths: true },
}))
