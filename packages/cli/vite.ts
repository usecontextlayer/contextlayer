import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/app-resources"
import { type Databases, databaseResultSchema } from "@usecontextlayer/shared/databases"
import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import type { LocalToolsProps } from "@usecontextlayer/shared/tools-worker"
import type { Plugin, ViteDevServer } from "vite"
import { getPlatformProxy, type PlatformProxy } from "wrangler"
import { getLocalAppId } from "@/app"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { prepareLocalResourceConfiguration } from "@/resources"

const setupPluginName = "contextlayer:database-setup"

export function localDatabaseSetup(
	bindings: Awaited<ReturnType<typeof getLocalResourcesBindings>>,
): Plugin {
	return {
		api: { bindings },
		async configureServer() {
			await setupLocalDatabases(bindings)
		},
		name: setupPluginName,
	}
}

export function getPreparedLocalBindings(server: ViteDevServer) {
	const plugin = server.config.plugins.find((plugin) => plugin.name === setupPluginName)
	assert(plugin, "Local databases require the ContextLayer Vite plugin")
	return plugin.api.bindings as Awaited<ReturnType<typeof getLocalResourcesBindings>>
}

export async function getLocalResourcesBindings() {
	const configuration = await prepareLocalResourceConfiguration()
	const { connections, databases } = resourcesForConsumer(configuration, { type: "app" })
	const workerName = `ctx-local-resources-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}`
	const proxyConfigPath = resolve(".contextlayer/database-proxy.json")
	await writeFile(
		proxyConfigPath,
		JSON.stringify({
			compatibility_date: "2026-10-02",
			name: `${workerName}-proxy`,
			services: [
				{
					binding: "DATABASE_SETUP",
					entrypoint: "DatabaseSetup",
					props: { databases: configuration.databases },
					service: workerName,
				},
			],
		}),
	)
	return {
		configuration,
		databaseProps: { databases },
		props: Object.keys(connections).length
			? ({
					appId: await getLocalAppId(),
					connections,
					credential: { token: await getAccessToken(env), type: "access-token" as const },
				} satisfies LocalToolsProps)
			: undefined,
		proxyConfigPath,
		vars: { CTX_PLATFORM_URL: env.CTX_PLATFORM_URL },
		workerName,
	}
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

export async function setupLocalDatabases(
	bindings: Awaited<ReturnType<typeof getLocalResourcesBindings>>,
) {
	const proxy = await getPlatformProxy<{ DATABASE_SETUP: Fetcher }>({
		configPath: bindings.proxyConfigPath,
		persist: false,
		remoteBindings: false,
	})
	try {
		const response = await proxy.env.DATABASE_SETUP.fetch(
			"http://local/databases/setup",
			{ method: "POST" },
		)
		if (!response.ok)
			throw new Error(`Local database setup failed: ${await response.text()}`)
	} finally {
		await proxy.dispose()
	}
}
