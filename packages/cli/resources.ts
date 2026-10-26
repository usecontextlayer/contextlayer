import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { resourcesSchema } from "@usecontextlayer/shared/declaration"
import {
	type LocalResourceConfiguration,
	localResourceConfigurationSchema,
} from "@usecontextlayer/shared/slate-resources"
import { z } from "zod"
import { readLocalSecret } from "@/env"
import { readLocalResources } from "@/slate"

const localConnectionsSchema = z.record(
	resourcesSchema.shape.connections.keyType,
	z.string().min(1),
)

async function readOptionalFile(path: string) {
	try {
		return await readFile(path, "utf8")
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
		throw error
	}
}

async function readLocalConnections(directory: string) {
	const contents = await readOptionalFile(
		resolve(directory, ".contextlayer/connections.json"),
	)
	return localConnectionsSchema.parse(contents === null ? {} : JSON.parse(contents))
}

export function getLocalResourcesWorkerName() {
	return `ctx-local-resources-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}`
}

export async function prepareLocalResourceConfiguration(
	directory = process.cwd(),
): Promise<LocalResourceConfiguration> {
	const resources = await readLocalResources(directory)
	const assignments = new Map(Object.entries(await readLocalConnections(directory)))
	return localResourceConfigurationSchema.parse({
		connections: Object.fromEntries(
			Object.entries(resources.connections).map(([slug, requirement]) => [
				slug,
				{ ...requirement, account_id: assignments.get(slug) ?? null },
			]),
		),
		databases: Object.fromEntries(
			Object.entries(resources.databases).map(([slug, requirement]) => [
				slug,
				{ ...requirement, instance_name: slug },
			]),
		),
		secrets: Object.fromEntries(
			Object.entries(resources.secrets).map(([name, requirement]) => [
				name,
				{ ...requirement, value: readLocalSecret(name) },
			]),
		),
	})
}

export async function saveLocalConnection(
	slug: string,
	accountId: string,
	directory = process.cwd(),
) {
	const assignment = localConnectionsSchema.parse({ [slug]: accountId })
	const connections = { ...(await readLocalConnections(directory)), ...assignment }
	await mkdir(resolve(directory, ".contextlayer"), { recursive: true })
	await writeFile(
		resolve(directory, ".contextlayer/connections.json"),
		`${JSON.stringify(connections, null, 2)}\n`,
	)
}
