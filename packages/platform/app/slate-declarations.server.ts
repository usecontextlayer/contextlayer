import {
	collectSlateResources,
	declarationSchema,
	type SlateDeclarations,
} from "@usecontextlayer/shared/declaration"
import type { SlateId } from "@/database/models/public/Slate"

export type SlateDeclarationSnapshot = Extract<
	Awaited<ReturnType<typeof readSlateDeclarations>>,
	{ state: "snapshot" }
>

export async function readSlateDeclarations(artifacts: Artifacts, slateId: SlateId) {
	using repo = await artifacts.get(slateId)
	const [commit] = await repo.log({ limit: 1, ref: "main" })
	if (!commit) return { state: "no-commit" } as const

	const root = (await repo.readTree(commit.treeHash)) as ArtifactsTreeEntry[]
	const directory = root.find((entry) => entry.name === "agents" && entry.type === "tree")
	const definitions = directory
		? ((await repo.readTree(directory.hash)) as ArtifactsTreeEntry[])
		: []
	const agentTrees = definitions.filter((entry) => entry.type === "tree")
	const agents = await Promise.all(
		agentTrees.map(
			async ({ name }) =>
				[
					name,
					await readDeclaration(repo, commit.hash, `agents/${name}/slate.json`),
				] as const,
		),
	)
	const declarations: SlateDeclarations = {
		agents: Object.fromEntries(agents),
		app: await readDeclaration(repo, commit.hash, "public/slate.json"),
	}
	return {
		agentTrees,
		commit: commit.hash,
		declarations,
		resources: collectSlateResources(declarations),
		state: "snapshot" as const,
	}
}

async function readDeclaration(repo: ArtifactsRepo, commit: string, path: string) {
	const file = await repo.readFile({ path, ref: commit })
	if (!file) throw new Error(`Slate declaration not found: ${path}`)
	return declarationSchema.parse(JSON.parse(await file.text()))
}
