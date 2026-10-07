import { setupAgentSchedules } from "@/agent-schedules.server"
import type { AgentActor } from "@/agents.schema"
import { readAppDeclarations } from "@/app-declarations.server"
import { prepareAppFolderConfiguration } from "@/app-resources.server"
import type { App } from "@/apps.schema"
import type { PlatformEnv } from "@/context"

export async function setupApp(
	artifacts: Artifacts,
	folders: Artifacts,
	agents: PlatformEnv["Bindings"]["AGENTS"],
	app: App,
	actors: AgentActor[],
) {
	const snapshot = await readAppDeclarations(artifacts, app.id)
	if (snapshot.state === "no-commit") return
	const repositories = new Set<string>()
	for (const actor of actors) {
		if (actor.type !== "user") continue
		const configuration = prepareAppFolderConfiguration(
			app,
			actor,
			snapshot.resources.folders,
		)
		for (const { repository_name } of Object.values(configuration))
			repositories.add(repository_name)
	}
	let cursor: string | undefined
	while (repositories.size > 0) {
		const page = await folders.list({ cursor, limit: 200 })
		for (const { name } of page.repos) repositories.delete(name)
		if (!page.cursor) break
		cursor = page.cursor
	}
	for (const name of repositories)
		await folders.create(name, { setDefaultBranch: "main" })
	await setupAgentSchedules(artifacts, agents, app.id, actors, snapshot)
}
