import { slateSchema } from "@/app-connections.schema"

// An agent is the directory `agents/<name>/` in its app's repository, written in eve's layout.
// Loading reads it from one commit, the latest on main, and compiles it into the files Claude Code
// reads, keyed by their path under the directory Claude Code runs in: `instructions.md` becomes
// `CLAUDE.md`, a flat skill `skills/<skill>.md` becomes `.claude/skills/<skill>/SKILL.md`, and a
// packaged skill `skills/<skill>/**` moves under `.claude/` unchanged.
export async function loadAgent(artifacts: Artifacts, appId: string, name: string) {
	using repo = await artifacts.get(appId)
	const [commit] = await repo.log({ limit: 1, ref: "main" })
	if (!commit) return null
	const directory = await findTree(repo, commit.treeHash, ["agents", name])
	if (!directory) return null
	const read = async (path: string) =>
		(await repo.readFile({ path: `agents/${name}/${path}`, ref: commit.hash }))?.text()

	const instructions = await read("instructions.md")
	if (instructions === undefined) throw new Error(`Agent ${name} has no instructions.md`)
	const outputSchema = await read("output.schema.json")
	if (outputSchema === undefined)
		throw new Error(`Agent ${name} has no output.schema.json`)
	const manifest = await read("slate.json")

	const files: Record<string, string> = { "CLAUDE.md": instructions }
	const skills = directory.find(
		(entry) => entry.name === "skills" && entry.type === "tree",
	)
	if (skills) {
		for (const [path, hash] of await listBlobs(repo, skills.hash, "")) {
			const blob = await repo.readBlob(hash)
			if (!blob) throw new Error(`Agent ${name} skill file ${path} is missing`)
			const flatSkill = path.match(/^([^/]+)\.md$/)
			files[
				flatSkill ? `.claude/skills/${flatSkill[1]}/SKILL.md` : `.claude/skills/${path}`
			] = await blob.text()
		}
	}
	return {
		commit: commit.hash,
		files,
		manifest: slateSchema.parse(manifest === undefined ? {} : JSON.parse(manifest)),
		outputSchema,
	}
}

async function findTree(repo: ArtifactsRepo, rootHash: string, segments: string[]) {
	let entries = await repo.readTree(rootHash)
	for (const segment of segments) {
		const entry = entries?.find(
			(child) => child.name === segment && child.type === "tree",
		)
		if (!entry) return null
		entries = await repo.readTree(entry.hash)
	}
	return entries
}

async function listBlobs(
	repo: ArtifactsRepo,
	treeHash: string,
	prefix: string,
): Promise<[string, string][]> {
	const blobs: [string, string][] = []
	for (const entry of (await repo.readTree(treeHash)) ?? []) {
		if (entry.type === "tree") {
			blobs.push(...(await listBlobs(repo, entry.hash, `${prefix}${entry.name}/`)))
		} else {
			blobs.push([`${prefix}${entry.name}`, entry.hash])
		}
	}
	return blobs
}
