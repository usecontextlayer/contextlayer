import { contextlayer } from "@usecontextlayer/sdk/vite"
import { defineConfig } from "vite"

export default defineConfig((env) => ({
	environments: {
		client: { build: { outDir: "build/client" } },
		ssr: { build: { outDir: "build/server" } },
	},
	plugins: [contextlayer(env)],
	resolve: { tsconfigPaths: true },
}))
