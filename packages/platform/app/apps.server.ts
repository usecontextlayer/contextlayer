import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import {
	type App,
	type AppOwnerFilter,
	type AppTarget,
	appSchema,
	DEFAULT_APP_VISIBILITY,
	publicHostnameSchema,
} from "@/apps.schema"
import { type AuthIdentity, listOrganizationIds } from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"
import type { Owner } from "@/owner"

export type AppAccess = { app: App; identity: AuthIdentity }

export async function listApps(
	db: PlatformDb,
	artifacts: Artifacts,
	identity: AuthIdentity,
	issuer: string,
	filter: AppOwnerFilter,
) {
	let query = db.selectFrom("app").selectAll().orderBy("public_hostname")
	if (filter.type === "user") query = query.where("owner_user_id", "=", filter.id)
	if (filter.type === "organization")
		query = query.where("owner_organization_id", "=", filter.id)
	const rows = await query.execute()
	const storedApps = rows.map((row) => appSchema.parse(row))
	const organizationIds = storedApps.some((app) => app.owner_organization_id !== null)
		? await listOrganizationIds(identity, issuer)
		: []
	const apps = []
	for (const app of storedApps) {
		if (!authorizeAppManagement(app, identity, organizationIds).allowed) continue
		using repo = await artifacts.get(app.id)
		const commits = await repo.log({ limit: 1, ref: "main" })
		apps.push({ ...app, latest_commit: commits[0]?.hash ?? null })
	}
	return apps
}

export async function resolveAppForViewing(
	db: PlatformDb,
	target: AppTarget,
	identity: AuthIdentity | null,
	issuer: string,
) {
	const app = await resolveApp(db, target)
	if (!app) return { allowed: false, reason: "not-found" } as const
	const organizationIds =
		identity && app.visibility === "private" && app.owner_organization_id
			? await listOrganizationIds(identity, issuer)
			: []
	return authorizeAppViewing(app, identity, organizationIds)
}

async function resolveApp(db: PlatformDb, target: AppTarget) {
	const query = db.selectFrom("app").selectAll()
	const row = await ("id" in target
		? query.where("id", "=", target.id)
		: query.where("public_hostname", "=", target.public_hostname)
	).executeTakeFirst()
	return row ? appSchema.parse(row) : null
}

export function authorizeAppViewing(
	app: App,
	identity: AuthIdentity | null,
	organizationIds: readonly string[],
) {
	if (app.visibility === "public") return { allowed: true, app, identity } as const
	return authorizeAppManagement(app, identity, organizationIds)
}

export function authorizeAppManagement(
	app: App,
	identity: AuthIdentity | null,
	organizationIds: readonly string[],
) {
	if (!identity) return { allowed: false, reason: "sign-in-required" } as const
	if (app.owner_user_id === identity.user.id)
		return { allowed: true, app, identity } as const
	if (app.owner_organization_id && organizationIds.includes(app.owner_organization_id)) {
		return { allowed: true, app, identity } as const
	}
	return { allowed: false, reason: "forbidden" } as const
}

export function createApp(
	db: PlatformDb,
	artifacts: Artifacts,
	appsDomain: string,
	owner: Owner,
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
				visibility: DEFAULT_APP_VISIBILITY,
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		await artifacts.create(app.id, { setDefaultBranch: "main" })
		return appSchema.parse(app)
	})
}

export async function getGitAccess(
	db: PlatformDb,
	artifacts: Artifacts,
	id: AppId,
	write: boolean,
	identity: AuthIdentity,
	issuer: string,
) {
	const app = await resolveApp(db, { id })
	if (!app) return { allowed: false, reason: "not-found" } as const
	const organizationIds = app.owner_organization_id
		? await listOrganizationIds(identity, issuer)
		: []
	const authorization = authorizeAppManagement(app, identity, organizationIds)
	if (!authorization.allowed) return authorization
	using repo = await artifacts.get(id)
	const info = await repo.info()
	const token = await repo.createToken(write ? "write" : "read", 3600)
	return { allowed: true, remote: info.remote, token: token.plaintext } as const
}
