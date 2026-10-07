import { readDatabaseMigrations } from "@usecontextlayer/shared/databases"
import {
	type AppSlates,
	collectAppResources,
	slateSchema,
} from "@usecontextlayer/shared/slate"
import type { AppId } from "@/database/models/public/App"

export type AppDeclarationSnapshot = Extract<
	Awaited<ReturnType<typeof readAppDeclarations>>,
	{ state: "snapshot" }
>

export async function readAppDeclarations(artifacts: Artifacts, appId: AppId) {
	using repo = await artifacts.get(appId)
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
				[name, await readSlate(repo, commit.hash, `agents/${name}/slate.json`)] as const,
		),
	)
	const slates: AppSlates = {
		agents: Object.fromEntries(agents),
		app: await readSlate(repo, commit.hash, "public/slate.json"),
	}
	const resources = collectAppResources(slates)
	const databases = Object.fromEntries(
		await Promise.all(
			Object.entries(resources.databases).map(
				async ([slug, requirement]) =>
					[
						slug,
						{
							...requirement,
							migrations: await readDatabaseMigrations(slug, async (path) => {
								const file = await repo.readFile({ path, ref: commit.hash })
								return file ? file.text() : null
							}),
						},
					] as const,
			),
		),
	)
	return {
		agentTrees,
		commit: commit.hash,
		resources: { ...resources, databases },
		slates,
		state: "snapshot" as const,
	}
}

async function readSlate(repo: ArtifactsRepo, commit: string, path: string) {
	const file = await repo.readFile({ path, ref: commit })
	if (!file) throw new Error(`App declaration not found: ${path}`)
	return slateSchema.parse(JSON.parse(await file.text()))
}
