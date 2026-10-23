import {
	collectSlateResources,
	declarationSchema,
	type SlateDeclarations,
} from "@usecontextlayer/shared/declaration"
import type { SlateDeclarationSnapshot } from "@usecontextlayer/shared/slate-provisioning"
import { noCommitSchema } from "@usecontextlayer/shared/slate-resources"
import type { SlateId } from "@/database/models/public/Slate"

export type { SlateDeclarationSnapshot } from "@usecontextlayer/shared/slate-provisioning"

export async function readLatestSlateDeclarations(
	artifacts: Artifacts,
	slateId: SlateId,
) {
	using repo = await artifacts.get(slateId)
	const [commit] = await repo.log({ limit: 1, ref: "main" })
	if (!commit)
		return { allowed: false, reason: noCommitSchema.shape.reason.value } as const
	return readSlateDeclarations(artifacts, slateId, commit.hash)
}

export async function readSlateDeclarations(
	artifacts: Artifacts,
	slateId: SlateId,
	revision: string,
): Promise<SlateDeclarationSnapshot> {
	using repo = await artifacts.get(slateId)
	const commit = await repo.readCommit(revision)
	if (!commit) throw new Error(`Slate commit not found: ${revision}`)

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
		allowed: true as const,
		commit: commit.hash,
		declarations,
		resources: collectSlateResources(declarations),
	}
}

async function readDeclaration(repo: ArtifactsRepo, commit: string, path: string) {
	const file = await repo.readFile({ path, ref: commit })
	if (!file) throw new Error(`Slate declaration not found: ${path}`)
	return declarationSchema.parse(JSON.parse(await file.text()))
}
