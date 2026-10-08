import { readDatabaseMigrations } from "@usecontextlayer/shared/databases"
import { setupAgentSchedules } from "@/agent-schedules.server"
import type { AgentActor } from "@/agents.schema"
import { readAppDeclarations } from "@/app-declarations.server"
import { prepareAppDatabaseConfiguration } from "@/app-resources.server"
import type { App } from "@/apps.schema"
import type { PlatformEnv } from "@/context"

export async function setupApp(
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	app: App,
	actors: AgentActor[],
) {
	const snapshot = await readAppDeclarations(artifacts, app.id)
	if (snapshot.state === "no-commit") return
	const instances = new Map<string, string>()
	for (const actor of actors) {
		if (actor.type !== "user") continue
		const configuration = prepareAppDatabaseConfiguration(
			app,
			actor,
			snapshot.resources.databases,
		)
		for (const [slug, { instance_name }] of Object.entries(configuration))
			instances.set(instance_name, slug)
	}
	using repo = await artifacts.get(app.id)
	for (const slug of Object.keys(snapshot.resources.databases)) {
		const migrations = await readDatabaseMigrations(slug, async (path) => {
			const file = await repo.readFile({ path, ref: snapshot.commit })
			return file ? file.text() : null
		})
		for (const [name, instanceSlug] of instances)
			if (instanceSlug === slug) await databases.getByName(name).setup(migrations)
	}
	await setupAgentSchedules(artifacts, agents, app.id, actors, snapshot)
}
