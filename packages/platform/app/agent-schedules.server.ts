import { getAgentByName } from "@usecontextlayer/shared/agent-routing"
import { resourcesForConsumer } from "@usecontextlayer/shared/declaration"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import { getAgentInstanceName, getAgentUnattendedScope } from "@/agent-instance"
import { agentScheduleSchema } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import { slateSchema } from "@/slates.schema"

export async function provisionAgentSchedules(
	artifacts: Artifacts,
	agents: PlatformEnv["Bindings"]["AGENTS"],
	{ slate, actors, snapshot }: SlateProvisioning,
) {
	const slateId = slateSchema.shape.id.parse(slate.id)
	const { parseSkillFrontmatter } = await import("agents/skills")
	using repo = await artifacts.get(slateId)
	for (const definition of snapshot.agentTrees) {
		const files = (await repo.readTree(definition.hash)) as ArtifactsTreeEntry[]
		if (!files.some((entry) => entry.name === "instructions.md" && entry.type === "blob"))
			continue
		const directory = files.find(
			(entry) => entry.name === "schedules" && entry.type === "tree",
		)
		const scheduleFiles = directory
			? ((await repo.readTree(directory.hash)) as ArtifactsTreeEntry[])
			: []
		const schedules = []
		for (const file of scheduleFiles.filter(
			(entry) => entry.type === "blob" && entry.name.endsWith(".md"),
		)) {
			const content = (await repo.readBlob(file.hash)) as Blob
			const { data, body } = parseSkillFrontmatter(await content.text())
			schedules.push(
				agentScheduleSchema.parse({
					cron: data.cron,
					name: file.name.slice(0, -3),
					prompt: body,
				}),
			)
		}
		const scope = getAgentUnattendedScope(
			resourcesForConsumer(snapshot.resources, { name: definition.name, type: "agent" }),
		)
		for (const actor of actors) {
			const instance = await getAgentByName(
				agents,
				getAgentInstanceName(slateId, definition.name, actor),
			)
			await instance.provisionSchedules(
				slateId,
				definition.name,
				actor,
				(scope === "member") === (actor.type === "user") ? schedules : [],
			)
		}
	}
}
