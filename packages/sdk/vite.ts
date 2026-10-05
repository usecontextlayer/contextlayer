import { cloudflare } from "@cloudflare/vite-plugin"
import { getLocalToolsBindings } from "@usecontextlayer/cli/vite"
import type { ConfigEnv } from "vite"

export async function contextlayer({ command }: ConfigEnv) {
	const bindings = command === "serve" ? await getLocalToolsBindings() : undefined
	return [
		{
			config: () => ({
				define: {
					"import.meta.env.CTX_APP_ID":
						JSON.stringify(bindings?.props.appId) ?? "undefined",
					"import.meta.env.CTX_APP_MANIFEST":
						JSON.stringify(JSON.stringify(bindings?.props.manifest)) ?? "undefined",
					"import.meta.env.CTX_PLATFORM_URL":
						JSON.stringify(bindings?.vars.CTX_PLATFORM_URL) ?? "undefined",
				},
			}),
			name: "contextlayer-chrome",
		},
		cloudflare({
			auxiliaryWorkers: [
				{
					config: bindings ? { vars: bindings.vars } : {},
					configPath: "workers/local-tools/wrangler.jsonc",
					devOnly: true,
				},
			],
			config: bindings
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
				: {},
			viteEnvironment: { name: "ssr" },
		}),
	]
}
