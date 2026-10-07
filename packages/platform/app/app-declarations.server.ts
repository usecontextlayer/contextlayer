import {
	type AppSlates,
	collectAppResources,
	slateSchema,
} from "@usecontextlayer/shared/slate"
import type { AppId } from "@/database/models/public/App"

export async function readAppDeclarations(artifacts: Artifacts, appId: AppId) {
	using repo = await artifacts.get(appId)
	const [commit] = await repo.log({ limit: 1, ref: "main" })
	if (!commit) throw new Error("App repository main commit not found")

	const root = (await repo.readTree(commit.treeHash)) as ArtifactsTreeEntry[]
	const readDefinitions = async (directoryName: "agents" | "mcp") => {
		const directory = root.find(
			(entry) => entry.name === directoryName && entry.type === "tree",
		)
		const definitions = directory
			? ((await repo.readTree(directory.hash)) as ArtifactsTreeEntry[])
			: []
		const trees = definitions.filter((entry) => entry.type === "tree")
		const slates = await Promise.all(
			trees.map(
				async ({ name }) =>
					[
						name,
						await readSlate(repo, commit.hash, `${directoryName}/${name}/slate.json`),
					] as const,
			),
		)
		return { slates: Object.fromEntries(slates), trees }
	}
	const [agents, mcp] = await Promise.all([
		readDefinitions("agents"),
		readDefinitions("mcp"),
	])
	const slates: AppSlates = {
		agents: agents.slates,
		app: await readSlate(repo, commit.hash, "public/slate.json"),
		mcp: mcp.slates,
	}
	return {
		agentTrees: agents.trees,
		commit: commit.hash,
		resources: collectAppResources(slates),
		slates,
	}
}

async function readSlate(repo: ArtifactsRepo, commit: string, path: string) {
	const file = await repo.readFile({ path, ref: commit })
	if (!file) throw new Error(`App declaration not found: ${path}`)
	return slateSchema.parse(JSON.parse(await file.text()))
}
