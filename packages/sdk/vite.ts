import { cloudflare } from "@cloudflare/vite-plugin"
import {
	getLocalResourcesBindings,
	localDatabaseProvisioning,
} from "@usecontextlayer/cli/vite"
import type { ConfigEnv } from "vite"
import { mcpApps } from "@/mcp-vite"

export async function contextlayer({ command }: ConfigEnv) {
	const bindings = command === "serve" ? await getLocalResourcesBindings() : undefined
	return [
		mcpApps(),
		cloudflare({
			auxiliaryWorkers: [
				{
					config: bindings ? { name: bindings.workerName, vars: bindings.vars } : {},
					configPath: "workers/local-resources/wrangler.jsonc",
					devOnly: true,
				},
			],
			config: {
				...(bindings
					? {
							services: [
								...(bindings.props
									? [
											{
												binding: "TOOLS",
												entrypoint: "Tools",
												props: bindings.props,
												service: bindings.workerName,
											},
										]
									: []),
								{
									binding: "DATABASES",
									entrypoint: "Databases",
									props: bindings.databaseProps,
									service: bindings.workerName,
								},
							],
						}
					: {}),
			},
			persistState: { path: ".contextlayer/databases" },
			viteEnvironment: { name: "ssr" },
		}),
		bindings ? localDatabaseProvisioning(bindings) : undefined,
	]
}
