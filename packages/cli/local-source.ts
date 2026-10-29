import { existsSync } from "node:fs"
import { glob, readFile } from "node:fs/promises"
import { join } from "node:path"
import { collectSlateResources } from "@usecontextlayer/shared/declaration"
import { getAccessToken } from "@/auth"
import { env } from "@/env"
import { type LocalSnapshot, localSnapshotSchema } from "@/local-runtime/schema"
import {
	getLocalResourcesWorkerName,
	prepareLocalResourceConfiguration,
} from "@/resources"
import { getLocalSlateId, readLocalDeclarations } from "@/slate"

export async function readLocalSnapshot(
	directory = process.cwd(),
): Promise<LocalSnapshot> {
	const declarations = await readLocalDeclarations(directory)
	const configuration = await prepareLocalResourceConfiguration(
		directory,
		collectSlateResources(declarations),
	)
	const agents: LocalSnapshot["agents"] = {}
	for (const name of Object.keys(declarations.agents)) {
		if (!existsSync(join(directory, "agents", name, "instructions.md"))) continue
		const instructions = await readFile(
			join(directory, "agents", name, "instructions.md"),
			"utf8",
		)
		const schedules: Record<string, string> = {}
		for await (const path of glob("schedules/*.md", {
			cwd: join(directory, "agents", name),
		})) {
			schedules[path.slice("schedules/".length, -3)] = await readFile(
				join(directory, "agents", name, path),
				"utf8",
			)
		}
		agents[name] = { instructions, schedules }
	}
	const needsGateway = Object.values(configuration.connections).some(
		({ account_id }) => account_id !== null,
	)
	return localSnapshotSchema.parse({
		agents,
		configuration,
		gateway: needsGateway
			? {
					platformUrl: env.CTX_PLATFORM_URL,
					slateId: await getLocalSlateId(directory),
					token: await getAccessToken(env),
				}
			: null,
		scope: getLocalResourcesWorkerName(directory),
		source: "working-tree",
	})
}
