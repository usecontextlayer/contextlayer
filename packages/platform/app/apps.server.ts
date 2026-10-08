import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import { joinApp } from "@/app-members.server"
import { provisionAppOAuth } from "@/app-oauth.server"
import {
	type App,
	type AppOwnerFilter,
	type AppTarget,
	appSchema,
	type CreateAppRequest,
	DEFAULT_APP_VISIBILITY,
	publicHostnameSchema,
	type UpdateAppVisibilityRequest,
} from "@/apps.schema"
import {
	type AuthIdentity,
	checkViewerOrganizationMembership,
	findOrganizationBySlug,
	listOrganizations,
} from "@/auth.server"
import type { PlatformDb } from "@/database"
import type { AppId } from "@/database/models/public/App"
import type { PlatformConfig } from "@/env"
import type { Owner, OwnerDetails } from "@/owner"

export type AppAccess = { app: App; identity: AuthIdentity }

export async function getApp(
	db: PlatformDb,
	target: AppTarget,
	identity: AuthIdentity,
	issuer: string,
) {
	const app = await resolveApp(db, target)
	if (!app) return { allowed: false, reason: "not-found" } as const
	const organization = app.owner_organization_id
		? (await listOrganizations(identity, issuer)).find(
				(item) => item.id === app.owner_organization_id,
			)
		: undefined
	const authorization = authorizeAppManagement(app, identity, !!organization)
	if (!authorization.allowed) return authorization
	const owner: OwnerDetails = organization
		? { ...organization, type: "organization" }
		: { id: identity.user.id, type: "user" }
	return { allowed: true, app, owner } as const
}

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
	const organizations = storedApps.some((app) => app.owner_organization_id !== null)
		? await listOrganizations(identity, issuer)
		: []
	const apps = storedApps.filter(
		(app) =>
			authorizeAppManagement(
				app,
				identity,
				organizations.some(
					(organization) => organization.id === app.owner_organization_id,
				),
			).allowed,
	)
	return Promise.all(
		apps.map(async (app) => {
			using repo = await artifacts.get(app.id)
			const commits = await repo.log({ limit: 1, ref: "main" })
			return { ...app, latest_commit: commits[0]?.hash ?? null }
		}),
	)
}

export async function resolveAppForViewing(
	db: PlatformDb,
	target: AppTarget,
	identity: AuthIdentity | null,
	issuer: string,
) {
	const app = await resolveApp(db, target)
	if (!app) return { allowed: false, reason: "not-found" } as const
	let isOwnerOrganizationMember = false
	if (identity && app.visibility === "private" && app.owner_organization_id) {
		isOwnerOrganizationMember =
			identity.credential.type === "session"
				? await checkViewerOrganizationMembership(
						identity.credential,
						app.owner_organization_id,
						issuer,
					)
				: (await listOrganizations(identity, issuer)).some(
						(organization) => organization.id === app.owner_organization_id,
					)
	}
	return authorizeAppViewing(app, identity, isOwnerOrganizationMember)
}

export async function resolveApp(db: PlatformDb, target: AppTarget) {
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
	isOwnerOrganizationMember: boolean,
) {
	if (app.visibility === "public") return { allowed: true, app, identity } as const
	return authorizeAppManagement(app, identity, isOwnerOrganizationMember)
}

export function authorizeAppManagement(
	app: App,
	identity: AuthIdentity | null,
	isOwnerOrganizationMember: boolean,
) {
	if (!identity) return { allowed: false, reason: "sign-in-required" } as const
	if (app.owner_user_id === identity.user.id)
		return { allowed: true, app, identity } as const
	if (isOwnerOrganizationMember) {
		return { allowed: true, app, identity } as const
	}
	return { allowed: false, reason: "forbidden" } as const
}

export async function createApp(
	db: PlatformDb,
	artifacts: Artifacts,
	config: Pick<
		PlatformConfig,
		"CTX_APPS_DOMAIN" | "CTX_AUTH_ISSUER" | "CTX_APP_OAUTH_PROVISIONING_SECRET"
	>,
	identity: AuthIdentity,
	input: CreateAppRequest,
) {
	const organization = input.organization_slug
		? await findOrganizationBySlug(
				identity,
				config.CTX_AUTH_ISSUER,
				input.organization_slug,
			)
		: undefined
	if (input.organization_slug && !organization) return null
	const owner: Owner = organization
		? { id: organization.id, type: "organization" }
		: { id: identity.user.id, type: "user" }
	const name = uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
	})
	const publicHostname = publicHostnameSchema.parse(`${name}.${config.CTX_APPS_DOMAIN}`)
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
		const saved = appSchema.parse(app)
		await joinApp(trx, { app: saved, identity })
		await provisionAppOAuth(
			saved,
			config.CTX_AUTH_ISSUER,
			config.CTX_APP_OAUTH_PROVISIONING_SECRET,
		)
		return saved
	})
}

export async function updateAppVisibility(
	db: PlatformDb,
	{ app, identity }: AppAccess,
	issuer: string,
	input: UpdateAppVisibilityRequest,
) {
	const organizations = app.owner_organization_id
		? await listOrganizations(identity, issuer)
		: []
	const authorization = authorizeAppManagement(
		app,
		identity,
		organizations.some((organization) => organization.id === app.owner_organization_id),
	)
	if (!authorization.allowed) return authorization
	const saved = await db
		.updateTable("app")
		.set({ visibility: input.visibility })
		.where("id", "=", app.id)
		.returningAll()
		.executeTakeFirstOrThrow()
	return { allowed: true, app: appSchema.parse(saved) } as const
}

export async function getGitAccess(
	db: PlatformDb,
	artifacts: Artifacts,
	id: AppId,
	write: boolean,
	identity: AuthIdentity,
	issuer: string,
) {
	const access = await getApp(db, { id }, identity, issuer)
	if (!access.allowed) return access
	using repo = await artifacts.get(id)
	const info = await repo.info()
	const token = await repo.createToken(write ? "write" : "read", 3600)
	return { allowed: true, remote: info.remote, token: token.plaintext } as const
}
