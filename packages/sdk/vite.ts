import { cloudflare } from "@cloudflare/vite-plugin"
import { getLocalToolsBindings } from "@usecontextlayer/cli/vite"
import type { ConfigEnv } from "vite"
import { mcpApps } from "@/mcp-vite"

export async function contextlayer({ command }: ConfigEnv) {
	const bindings = command === "serve" ? await getLocalToolsBindings() : undefined
	return [
		mcpApps(),
		cloudflare({
			auxiliaryWorkers: [
				{
					config: bindings ? { vars: bindings.vars } : {},
					configPath: "workers/local-tools/wrangler.jsonc",
					devOnly: true,
				},
			],
			config: {
				assets: { run_worker_first: ["/*", "!/mcp.json", "!/mcp-ui/*"] },
				...(bindings
					? {
							services: [
								{
									binding: "TOOLS",
									entrypoint: "Tools",
									props: bindings.props,
									service: "ctx-local-tools",
								},
							],
						}
					: {}),
			},
			viteEnvironment: { name: "ssr" },
		}),
	]
}
