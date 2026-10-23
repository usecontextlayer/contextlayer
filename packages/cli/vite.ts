import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type Databases, databaseResultSchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { LocalToolsProps } from "@usecontextlayer/shared/tools-worker"
import { execa } from "execa"
import type { Plugin, ViteDevServer } from "vite"
import { getPlatformProxy, type PlatformProxy } from "wrangler"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { prepareLocalResourceConfiguration } from "@/resources"
import { getLocalSlateId } from "@/slate"

const provisioningPluginName = "contextlayer:database-provisioning"

export function localDatabaseProvisioning(
	bindings: Awaited<ReturnType<typeof getLocalResourcesBindings>>,
): Plugin {
	return {
		api: { bindings },
		async configureServer() {
			await provisionLocalDatabases(bindings)
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

export function getLocalResourcesWorkerName() {
	return `ctx-local-resources-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}`
}

export async function openLocalDatabases(
	workerName: string,
	databases: LocalResourceConfiguration["databases"],
): Promise<{ databases: Databases; dispose: PlatformProxy["dispose"] }> {
	const configPath = resolve(".contextlayer/agent-database-proxy.json")
	await writeFile(
		configPath,
		JSON.stringify({
			compatibility_date: "2026-10-02",
			name: `${workerName}-agent-proxy`,
			services: [
				{
					binding: "DATABASES",
					entrypoint: "Databases",
					props: { databases },
					service: workerName,
				},
			],
		}),
	)
	const proxy = await getPlatformProxy<{ DATABASES: Fetcher }>({
		configPath,
		persist: false,
		remoteBindings: false,
	})
	return {
		databases: {
			async query(slug, sql, params = []) {
				const response = await proxy.env.DATABASES.fetch(
					new Request("http://local/databases/query", {
						body: JSON.stringify({ params, slug, sql }),
						headers: { "content-type": "application/json" },
						method: "POST",
					}),
				)
				if (!response.ok)
					throw new Error(`Local database query failed: ${await response.text()}`)
				return databaseResultSchema.parse(await response.json())
			},
		},
		dispose: proxy.dispose,
	}
}

export async function provisionLocalDatabases(
	bindings: Awaited<ReturnType<typeof getLocalResourcesBindings>>,
) {
	for (const slug of Object.keys(bindings.configuration.databases)) {
		await execa(
			"pnpm",
			[
				"exec",
				"kysely",
				"--config",
				`databases/${slug}/kysely.config.ts`,
				"migrate",
				"latest",
			],
			{ stdio: "inherit" },
		)
	}
}
