import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"
import type { AppUserUserId } from "@/database/models/public/AppUser"

// A folder is an `app_folder` row whose UUID names its Artifacts repository, and like an app the
// two are created in one transaction, so whether a folder exists is a Postgres fact: its first use
// creates it and every later use finds it. A null user is the app's shared folder; otherwise the
// folder belongs to that app user.
export function resolveFolder(
	db: PlatformDb,
	artifacts: Artifacts,
	appId: AppId,
	userId: AppUserUserId | null,
	slug: string,
) {
	return db.transaction().execute(async (trx) => {
		const created = await trx
			.insertInto("app_folder")
			.values({ app_id: appId, slug, user_id: userId })
			.onConflict((conflict) =>
				conflict.columns(["app_id", "user_id", "slug"]).doNothing(),
			)
			.returningAll()
			.executeTakeFirst()
		if (created) {
			await artifacts.create(created.id, { setDefaultBranch: "main" })
			return created
		}
		return trx
			.selectFrom("app_folder")
			.selectAll()
			.where("app_id", "=", appId)
			.where("user_id", "is not distinct from", userId)
			.where("slug", "=", slug)
			.executeTakeFirstOrThrow()
	})
}
