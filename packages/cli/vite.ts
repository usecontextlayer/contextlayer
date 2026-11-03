import {
	collectSlateResources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/declaration"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { LocalToolsProps } from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import type { Plugin } from "vite"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import {
	getLocalResourcesWorkerName,
	prepareLocalResourceConfiguration,
} from "@/resources"
import { getLocalSlateId, readLocalDeclarations } from "@/slate"

const provisioningPluginName = "contextlayer:database-provisioning"

export function localDatabaseProvisioning(
	bindings: NonNullable<Awaited<ReturnType<typeof getLocalResourcesBindings>>>,
): Plugin {
	return {
		async configureServer() {
			await provisionLocalDatabases(bindings.configuration.databases)
		},
		name: provisioningPluginName,
	}
}

export async function getLocalResourcesBindings() {
	const declarations = await readLocalDeclarations()
	if (!declarations.app) return
	const configuration = await prepareLocalResourceConfiguration(
		process.cwd(),
		collectSlateResources(declarations),
	)
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
