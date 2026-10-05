import { WorkerEntrypoint } from "cloudflare:workers"
import { getAgentByName } from "agents/routing"
import { parseSkillFrontmatter } from "agents/skills"
import type { z } from "zod"
import { agentScheduleSchema } from "@/agents.schema"
import { getAgentInstanceName } from "@/agents.server"
import { readAppDeclarations } from "@/app-declarations.server"
import { appSchema } from "@/apps.schema"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parseDatabaseEnv } from "@/env"

export async function publishAgentSchedules(
	artifacts: Artifacts,
	agents: PlatformEnv["Bindings"]["AGENTS"],
	appId: z.infer<typeof appSchema>["id"],
) {
	const snapshot = await readAppDeclarations(artifacts, appId)
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
		const instance = await getAgentByName(
			agents,
			getAgentInstanceName(appId, definition.name, { type: "app" }),
		)
		await instance.registerSchedules(appId, definition.name, schedules)
	}
}

export class Publication extends WorkerEntrypoint<PlatformEnv["Bindings"]> {
	async publish(appId: string) {
		const id = appSchema.shape.id.parse(appId)
		const config = parseDatabaseEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			await db
				.selectFrom("app")
				.select("id")
				.where("id", "=", id)
				.executeTakeFirstOrThrow()
			await publishAgentSchedules(this.env.ARTIFACTS, this.env.AGENTS, id)
		} finally {
			await db.destroy()
		}
	}
}
