import { WorkerEntrypoint } from "cloudflare:workers"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parseDatabaseEnv } from "@/env"
import { listSlateMembers } from "@/slate-members.server"
import { provisionSlate } from "@/slate-provisioning.server"
import { slateSchema } from "@/slates.schema"

export class Provisioning extends WorkerEntrypoint<PlatformEnv["Bindings"]> {
	async provision(slateId: string) {
		const id = slateSchema.shape.id.parse(slateId)
		const config = parseDatabaseEnv(this.env)
		const db = createPlatformDb(config.CTX_PLATFORM_DATABASE_URL)
		try {
			const slate = slateSchema.parse(
				await db
					.selectFrom("slate")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirstOrThrow(),
			)
			const members = await listSlateMembers(db, id)
			await provisionSlate(
				this.env.ARTIFACTS,
				this.env.DATABASES,
				this.env.AGENTS,
				slate,
				[
					{ type: "app" },
					...members.map(({ user_id }) => ({ id: user_id, type: "user" as const })),
				],
			)
		} finally {
			await db.destroy()
		}
	}
}
