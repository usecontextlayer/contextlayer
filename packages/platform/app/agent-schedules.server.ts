import { resourcesForConsumer } from "@usecontextlayer/shared/slate"
import { getAgentByName } from "agents/routing"
import { getAgentInstanceName, getAgentUnattendedScope } from "@/agent-instance"
import { type AgentActor, agentScheduleSchema } from "@/agents.schema"
import { readAppDeclarations } from "@/app-declarations.server"
import type { PlatformEnv } from "@/context"
import type { AppId } from "@/database/models/public/App"

export async function setupAgentSchedules(
	artifacts: Artifacts,
	agents: PlatformEnv["Bindings"]["AGENTS"],
	appId: AppId,
	actors: AgentActor[],
) {
	const snapshot = await readAppDeclarations(artifacts, appId)
	if (snapshot.state === "no-commit") return
	const { parseSkillFrontmatter } = await import("agents/skills")
	using repo = await artifacts.get(appId)
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
				getAgentInstanceName(appId, definition.name, actor),
			)
			await instance.registerSchedules(
				appId,
				definition.name,
				actor,
				(scope === "member") === (actor.type === "user") ? schedules : [],
			)
		}
	}
}
