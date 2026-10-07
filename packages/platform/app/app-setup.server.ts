import type { DatabaseMigrations } from "@usecontextlayer/shared/databases"
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
	const instances = new Map<string, DatabaseMigrations>()
	for (const actor of actors) {
		if (actor.type !== "user") continue
		const configuration = prepareAppDatabaseConfiguration(
			app,
			actor,
			snapshot.resources.databases,
		)
		for (const { instance_name, migrations } of Object.values(configuration))
			instances.set(instance_name, migrations)
	}
	for (const [name, migrations] of instances)
		await databases.getByName(name).setup(migrations)
	await setupAgentSchedules(artifacts, agents, app.id, actors, snapshot)
}
