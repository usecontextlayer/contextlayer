import { readDatabaseMigrations } from "@usecontextlayer/shared/databases"
import { provisionAgentSchedules } from "@/agent-schedules.server"
import type { AgentActor } from "@/agents.schema"
import type { PlatformEnv } from "@/context"
import { readSlateDeclarations } from "@/slate-declarations.server"
import { prepareSlateDatabaseConfiguration } from "@/slate-resources.server"
import type { Slate } from "@/slates.schema"

export async function provisionSlate(
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	slate: Slate,
	actors: AgentActor[],
) {
	const snapshot = await readSlateDeclarations(artifacts, slate.id)
	if (!snapshot.allowed) return
	const instances = new Map<string, string>()
	for (const actor of actors) {
		if (actor.type !== "user") continue
		const configuration = prepareSlateDatabaseConfiguration(
			slate,
			actor,
			snapshot.resources.databases,
		)
		for (const [slug, { instance_name }] of Object.entries(configuration))
			instances.set(instance_name, slug)
	}
	using repo = await artifacts.get(slate.id)
	for (const slug of Object.keys(snapshot.resources.databases)) {
		const migrations = await readDatabaseMigrations(slug, async (path) => {
			const file = await repo.readFile({ path, ref: snapshot.commit })
			return file ? file.text() : null
		})
		for (const [name, instanceSlug] of instances)
			if (instanceSlug === slug) await databases.getByName(name).migrate(migrations)
	}
	await provisionAgentSchedules(artifacts, agents, slate.id, actors, snapshot)
}
