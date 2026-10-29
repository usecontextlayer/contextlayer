import { cloudflare } from "@cloudflare/vite-plugin"
import { getLocalResourcesWorkerName } from "@usecontextlayer/cli/vite"
import type { ConfigEnv } from "vite"
import { mcpApps } from "@/mcp-vite"

export async function contextlayer({ command }: ConfigEnv) {
	const workerName = command === "serve" ? getLocalResourcesWorkerName() : undefined
	return [
		mcpApps(),
		cloudflare({
			config: workerName
				? {
						services: [
							{ binding: "TOOLS", entrypoint: "Tools", service: workerName },
							{ binding: "DATABASES", entrypoint: "AppDatabases", service: workerName },
						],
					}
				: {},
			viteEnvironment: { name: "ssr" },
		}),
	]
}
