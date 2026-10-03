import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import { publicHostnameSchema } from "@/apps.schema"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"

export type AppOwner = { type: "user"; id: string } | { type: "organization"; id: string }

export async function listApps(db: PlatformDb, artifacts: Artifacts) {
	const apps = await db.selectFrom("app").selectAll().orderBy("public_hostname").execute()
	return Promise.all(
		apps.map(async (app) => {
			using repo = await artifacts.get(app.id)
			const commits = await repo.log({ limit: 1, ref: "main" })
			return { ...app, latest_commit: commits[0]?.hash ?? null }
		}),
	)
}

export function resolveApp(db: PlatformDb, hostname: string) {
	return db
		.selectFrom("app")
		.select("id")
		.where("public_hostname", "=", hostname)
		.executeTakeFirst()
}

export function createApp(
	db: PlatformDb,
	artifacts: Artifacts,
	appsDomain: string,
	owner: AppOwner,
) {
	const name = uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
	})
	const publicHostname = publicHostnameSchema.parse(`${name}.${appsDomain}`)
	return db.transaction().execute(async (trx) => {
		const app = await trx
			.insertInto("app")
			.values({
				owner_organization_id: owner.type === "organization" ? owner.id : null,
				owner_user_id: owner.type === "user" ? owner.id : null,
				public_hostname: publicHostname,
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		await artifacts.create(app.id, { setDefaultBranch: "main" })
		return app
	})
}

export async function getGitAccess(
	db: PlatformDb,
	artifacts: Artifacts,
	id: AppId,
	write: boolean,
) {
	const app = await db
		.selectFrom("app")
		.select("id")
		.where("id", "=", id)
		.executeTakeFirst()
	if (!app) return null
	using repo = await artifacts.get(id)
	const info = await repo.info()
	const token = await repo.createToken(write ? "write" : "read", 3600)
	return { remote: info.remote, token: token.plaintext }
}
