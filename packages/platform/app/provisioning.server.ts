import { WorkerEntrypoint } from "cloudflare:workers"
import type { DirectoryBackup } from "@cloudflare/ci/worker"
import type { SlateProvisioning } from "@usecontextlayer/shared/slate-provisioning"
import { provisionAgentSchedules } from "@/agent-schedules.server"
import type { PlatformEnv } from "@/context"
import { createPlatformDb } from "@/database"
import { parseDatabaseEnv } from "@/env"
import { migrateSlateDatabases } from "@/slate-database-migrations.server"
import { readSlateDeclarations } from "@/slate-declarations.server"
import { listSlateMembers } from "@/slate-members.server"
import { prepareSlateProvisioning } from "@/slate-provisioning.server"
import { slateSchema } from "@/slates.schema"

export class Provisioning extends WorkerEntrypoint<PlatformEnv["Bindings"]> {
	async prepare(slateId: string, commit: string) {
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
			const snapshot = await readSlateDeclarations(this.env.ARTIFACTS, id, commit)
			return prepareSlateProvisioning(
				slate,
				[
					{ type: "app" },
					...members.map(({ user_id }) => ({ id: user_id, type: "user" as const })),
				],
				snapshot,
			)
		} finally {
			await db.destroy()
		}
	}

	async migrate(prepared: SlateProvisioning, restore?: DirectoryBackup) {
		await migrateSlateDatabases(this.env.ARTIFACTS, this.env.SANDBOX, prepared, restore)
	}

	async provisionSchedules(prepared: SlateProvisioning) {
		await provisionAgentSchedules(this.env.ARTIFACTS, this.env.AGENTS, prepared)
	}
}
