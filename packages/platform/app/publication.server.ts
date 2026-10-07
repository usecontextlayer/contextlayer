import { WorkerEntrypoint } from "cloudflare:workers"
import { setupAgentSchedules } from "@/agent-schedules.server"
import { listAppMembers } from "@/app-members.server"
import { appSchema } from "@/apps.schema"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parseDatabaseEnv } from "@/env"

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
			const members = await listAppMembers(db, id)
			await setupAgentSchedules(this.env.ARTIFACTS, this.env.AGENTS, id, [
				{ type: "app" },
				...members.map(({ user_id }) => ({ id: user_id, type: "user" as const })),
			])
		} finally {
			await db.destroy()
		}
	}
}
