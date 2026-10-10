import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import {
	type AuthIdentity,
	checkViewerOrganizationMembership,
	findOrganizationBySlug,
	listOrganizations,
	type OwnerIdentity,
} from "@/auth.server"
import type { PlatformEnv } from "@/context"
import type { PlatformDb } from "@/database"
import type { SlateId } from "@/database/models/public/Slate"
import type { PlatformConfig } from "@/env"
import type { Owner, OwnerDetails } from "@/owner"
import { joinSlate } from "@/slate-members.server"
import { provisionSlateOAuth } from "@/slate-oauth.server"
import {
	type CreateSlateRequest,
	DEFAULT_SLATE_VISIBILITY,
	publicHostnameSchema,
	type Slate,
	type SlateOwnerFilter,
	type SlateTarget,
	slateSchema,
	type UpdateSlateVisibilityRequest,
} from "@/slates.schema"

export type SlateAccess = { slate: Slate; identity: AuthIdentity }
export type OwnerSlateAccess = SlateAccess & { identity: OwnerIdentity }

export async function getSlate(
	db: PlatformDb,
	target: SlateTarget,
	identity: OwnerIdentity,
	issuer: string,
) {
	const slate = await resolveSlate(db, target)
	if (!slate) return { allowed: false, reason: "not-found" } as const
	const organization = slate.owner_organization_id
		? (await listOrganizations(identity, issuer)).find(
				(item) => item.id === slate.owner_organization_id,
			)
		: undefined
	const authorization = authorizeSlateManagement(slate, identity, !!organization)
	if (!authorization.allowed) return authorization
	const owner: OwnerDetails = organization
		? { ...organization, type: "organization" }
		: { id: identity.user.id, type: "personal" }
	return { allowed: true, owner, slate } as const
}

export async function listSlates(
	db: PlatformDb,
	artifacts: Artifacts,
	identity: OwnerIdentity,
	issuer: string,
	filter: SlateOwnerFilter,
) {
	let query = db.selectFrom("slate").selectAll().orderBy("public_hostname")
	if (filter.type === "personal") query = query.where("owner_user_id", "=", filter.id)
	if (filter.type === "organization")
		query = query.where("owner_organization_id", "=", filter.id)
	const rows = await query.execute()
	const storedSlates = rows.map((row) => slateSchema.parse(row))
	const organizations = storedSlates.some((slate) => slate.owner_organization_id !== null)
		? await listOrganizations(identity, issuer)
		: []
	const slates = storedSlates.filter(
		(slate) =>
			authorizeSlateManagement(
				slate,
				identity,
				organizations.some(
					(organization) => organization.id === slate.owner_organization_id,
				),
			).allowed,
	)
	return Promise.all(
		slates.map(async (slate) => {
			using repo = await artifacts.get(slate.id)
			const commits = await repo.log({ limit: 1, ref: "main" })
			return { ...slate, latest_commit: commits[0]?.hash ?? null }
		}),
	)
}

export async function resolveSlateForViewing(
	db: PlatformDb,
	target: SlateTarget,
	identity: AuthIdentity | null,
	issuer: string,
) {
	const slate = await resolveSlate(db, target)
	if (!slate) return { allowed: false, reason: "not-found" } as const
	let isOwnerOrganizationMember = false
	if (identity && slate.visibility === "private" && slate.owner_organization_id) {
		isOwnerOrganizationMember =
			identity.type === "viewer"
				? await checkViewerOrganizationMembership(
						identity,
						slate.owner_organization_id,
						issuer,
					)
				: (await listOrganizations(identity, issuer)).some(
						(organization) => organization.id === slate.owner_organization_id,
					)
	}
	return authorizeSlateViewing(slate, identity, isOwnerOrganizationMember)
}

export async function resolveSlate(db: PlatformDb, target: SlateTarget) {
	const query = db.selectFrom("slate").selectAll()
	const row = await ("id" in target
		? query.where("id", "=", target.id)
		: query.where("public_hostname", "=", target.public_hostname)
	).executeTakeFirst()
	return row ? slateSchema.parse(row) : null
}

export function authorizeSlateViewing(
	slate: Slate,
	identity: AuthIdentity | null,
	isOwnerOrganizationMember: boolean,
) {
	if (slate.visibility === "public") return { allowed: true, identity, slate } as const
	return authorizeSlateOwnership(slate, identity, isOwnerOrganizationMember)
}

export function authorizeSlateManagement(
	slate: Slate,
	identity: OwnerIdentity | null,
	isOwnerOrganizationMember: boolean,
) {
	return authorizeSlateOwnership(slate, identity, isOwnerOrganizationMember)
}

function authorizeSlateOwnership<T extends AuthIdentity>(
	slate: Slate,
	identity: T | null,
	isOwnerOrganizationMember: boolean,
) {
	if (!identity) return { allowed: false, reason: "sign-in-required" } as const
	if (slate.owner_user_id === identity.user.id)
		return { allowed: true, identity, slate } as const
	if (isOwnerOrganizationMember) {
		return { allowed: true, identity, slate } as const
	}
	return { allowed: false, reason: "forbidden" } as const
}

export async function createSlate(
	db: PlatformDb,
	artifacts: Artifacts,
	databases: PlatformEnv["Bindings"]["DATABASES"],
	agents: PlatformEnv["Bindings"]["AGENTS"],
	config: Pick<
		PlatformConfig,
		"CTX_SLATES_DOMAIN" | "CTX_AUTH_ISSUER" | "CTX_APP_OAUTH_PROVISIONING_SECRET"
	>,
	identity: OwnerIdentity,
	input: CreateSlateRequest,
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
		: { id: identity.user.id, type: "personal" }
	const name = uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
	})
	const publicHostname = publicHostnameSchema.parse(`${name}.${config.CTX_SLATES_DOMAIN}`)
	return db.transaction().execute(async (trx) => {
		const slate = await trx
			.insertInto("slate")
			.values({
				owner_organization_id: owner.type === "organization" ? owner.id : null,
				owner_user_id: owner.type === "personal" ? owner.id : null,
				public_hostname: publicHostname,
				visibility: DEFAULT_SLATE_VISIBILITY,
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		await artifacts.create(slate.id, { setDefaultBranch: "main" })
		const saved = slateSchema.parse(slate)
		await joinSlate(trx, artifacts, databases, agents, { identity, slate: saved })
		await provisionSlateOAuth(
			saved,
			config.CTX_AUTH_ISSUER,
			config.CTX_APP_OAUTH_PROVISIONING_SECRET,
		)
		return saved
	})
}

export async function updateSlateVisibility(
	db: PlatformDb,
	{ slate, identity }: OwnerSlateAccess,
	issuer: string,
	input: UpdateSlateVisibilityRequest,
) {
	const organizations = slate.owner_organization_id
		? await listOrganizations(identity, issuer)
		: []
	const authorization = authorizeSlateManagement(
		slate,
		identity,
		organizations.some((organization) => organization.id === slate.owner_organization_id),
	)
	if (!authorization.allowed) return authorization
	const saved = await db
		.updateTable("slate")
		.set({ visibility: input.visibility })
		.where("id", "=", slate.id)
		.returningAll()
		.executeTakeFirstOrThrow()
	return { allowed: true, slate: slateSchema.parse(saved) } as const
}

export async function getGitAccess(
	db: PlatformDb,
	artifacts: Artifacts,
	id: SlateId,
	write: boolean,
	identity: OwnerIdentity,
	issuer: string,
) {
	const access = await getSlate(db, { id }, identity, issuer)
	if (!access.allowed) return access
	using repo = await artifacts.get(id)
	const info = await repo.info()
	const token = await repo.createToken(write ? "write" : "read", 3600)
	return { allowed: true, remote: info.remote, token: token.plaintext } as const
}
