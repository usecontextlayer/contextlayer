import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
	type LocalResourceConfiguration,
	localResourceConfigurationSchema,
} from "@usecontextlayer/shared/app-resources"
import { resourcesSchema } from "@usecontextlayer/shared/slate"
import { z } from "zod"
import { readLocalResources } from "@/app"
import { readLocalSecret } from "@/env"

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

async function prepareLocalDirectory(directory: string) {
	await mkdir(resolve(directory, ".contextlayer"), { recursive: true })
	const ignorePath = resolve(directory, ".gitignore")
	const contents = (await readOptionalFile(ignorePath)) ?? ""
	if (!contents.split(/\r?\n/).includes("/.contextlayer/")) {
		await writeFile(
			ignorePath,
			`${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}/.contextlayer/\n`,
		)
	}
}

export async function prepareLocalResourceConfiguration(
	directory = process.cwd(),
): Promise<LocalResourceConfiguration> {
	const resources = await readLocalResources(directory)
	const bindings = new Map(Object.entries(await readLocalConnections(directory)))
	const configuration = localResourceConfigurationSchema.parse({
		connections: Object.fromEntries(
			Object.entries(resources.connections).map(([slug, requirement]) => [
				slug,
				{ ...requirement, connection_id: bindings.get(slug) ?? null },
			]),
		),
		folders: Object.fromEntries(
			Object.entries(resources.folders).map(([slug, requirement]) => [
				slug,
				{ ...requirement, path: resolve(directory, ".contextlayer", "folders", slug) },
			]),
		),
		secrets: Object.fromEntries(
			Object.entries(resources.secrets).map(([name, requirement]) => [
				name,
				{ ...requirement, value: readLocalSecret(name) },
			]),
		),
	})
	await prepareLocalDirectory(directory)
	await Promise.all(
		Object.values(configuration.folders).map(({ path }) =>
			mkdir(path, { recursive: true }),
		),
	)
	return configuration
}

export async function saveLocalConnection(
	slug: string,
	connectionId: string,
	directory = process.cwd(),
) {
	const binding = localConnectionsSchema.parse({ [slug]: connectionId })
	const connections = { ...(await readLocalConnections(directory)), ...binding }
	await prepareLocalDirectory(directory)
	await writeFile(
		resolve(directory, ".contextlayer/connections.json"),
		`${JSON.stringify(connections, null, 2)}\n`,
	)
}
