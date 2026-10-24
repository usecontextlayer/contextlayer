import assert from "node:assert/strict"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { LocalToolsProps } from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import type { Plugin, ViteDevServer } from "vite"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import {
	getLocalResourcesWorkerName,
	prepareLocalResourceConfiguration,
} from "@/resources"
import { getLocalSlateId } from "@/slate"

const provisioningPluginName = "contextlayer:database-provisioning"

export function localDatabaseProvisioning(
	bindings: Awaited<ReturnType<typeof getLocalResourcesBindings>>,
): Plugin {
	return {
		api: { bindings },
		async configureServer() {
			await provisionLocalDatabases(bindings.configuration.databases)
		},
		name: provisioningPluginName,
	}
}

export function getPreparedLocalBindings(server: ViteDevServer) {
	const plugin = server.config.plugins.find(
		(plugin) => plugin.name === provisioningPluginName,
	)
	assert(plugin, "Local databases require the ContextLayer Vite plugin")
	return plugin.api.bindings as Awaited<ReturnType<typeof getLocalResourcesBindings>>
}

export async function getLocalResourcesBindings() {
	const configuration = await prepareLocalResourceConfiguration()
	const { connections, databases } = resourcesForConsumer(configuration, { type: "app" })
	const workerName = getLocalResourcesWorkerName()
	return {
		configuration,
		databaseProps: { databases },
		props: Object.keys(connections).length
			? ({
					connections,
					credential: { token: await getAccessToken(env), type: "access-token" as const },
					slateId: await getLocalSlateId(),
				} satisfies LocalToolsProps)
			: undefined,
		vars: { CTX_PLATFORM_URL: env.CTX_PLATFORM_URL },
		workerName,
	}
}

export async function provisionLocalDatabases(
	databases: LocalResourceConfiguration["databases"],
) {
	for (const slug of Object.keys(databases)) {
		await execa(
			"pnpm",
			[
				"exec",
				"kysely",
				"--no-outdated-check",
				"--config",
				`databases/${slug}/kysely.config.ts`,
				"migrate",
				"latest",
			],
			{ stdio: "inherit" },
		)
	}
}
