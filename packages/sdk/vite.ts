import { cloudflare } from "@cloudflare/vite-plugin"
import { getLocalToolsBindings } from "@usecontextlayer/cli/vite"
import type { ConfigEnv } from "vite"

export async function contextlayer({ command }: ConfigEnv) {
	return cloudflare({
		auxiliaryWorkers: [
			{
				config: command === "serve" ? { vars: await getLocalToolsBindings() } : {},
				configPath: "workers/local-tools/wrangler.jsonc",
				devOnly: true,
			},
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
	})
}
