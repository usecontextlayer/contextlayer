import { WorkerEntrypoint } from "cloudflare:workers"
import { listAppMembers } from "@/app-members.server"
import { setupApp } from "@/app-setup.server"
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
			const app = appSchema.parse(
				await db
					.selectFrom("app")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirstOrThrow(),
			)
			const members = await listAppMembers(db, id)
			await setupApp(this.env.ARTIFACTS, this.env.FOLDERS, this.env.AGENTS, app, [
				{ type: "app" },
				...members.map(({ user_id }) => ({ id: user_id, type: "user" as const })),
			])
		} finally {
			await db.destroy()
		}
	}
}
