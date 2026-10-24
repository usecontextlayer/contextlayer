import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { DatabaseSession } from "@usecontextlayer/shared/database-dialect"
import { type Databases, databaseResultSchema } from "@usecontextlayer/shared/databases"
import type { LocalResourceConfiguration } from "@usecontextlayer/shared/slate-resources"
import type { PlatformProxy } from "wrangler"
import {
	getLocalResourcesWorkerName,
	prepareLocalResourceConfiguration,
} from "@/resources"

export async function openLocalDatabases(
	workerName: string,
	databases: LocalResourceConfiguration["databases"],
): Promise<{ databases: Databases; dispose: PlatformProxy["dispose"] }> {
	const configPath = resolve(".contextlayer/database-proxy.json")
	await mkdir(dirname(configPath), { recursive: true })
	await writeFile(
		configPath,
		JSON.stringify({
			compatibility_date: "2026-10-02",
			name: `${workerName}-database-proxy`,
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
	const { getPlatformProxy } = await import("wrangler")
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

export async function openLocalDatabase(slug: string): Promise<DatabaseSession> {
	const configuration = await prepareLocalResourceConfiguration()
	const connection = await openLocalDatabases(
		getLocalResourcesWorkerName(),
		configuration.databases,
	)
	return {
		destroy: connection.dispose,
		query: (sql, params) => connection.databases.query(slug, sql, params),
	}
}
