import { join } from "node:path"
import { assertMigrationSucceeded, createMigrator } from "@usecontextlayer/db-infra"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { appConnectionsSchema } from "@usecontextlayer/shared/app-connections"
import {
	appSlatesSchema,
	collectAppResources,
	slateSchema,
} from "@usecontextlayer/shared/slate"
import { sql } from "kysely"
import { expect, test } from "vitest"
import { assignmentSchema } from "@/app-connections.schema"
import {
	assignAppConnection,
	listAppConnections,
	resolveAppConnection,
} from "@/app-connections.server"
import type { ResourcesSnapshot } from "@/app-resources.server"
import { appSchema } from "@/apps.schema"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { getCredentialOwner } from "@/owner"

test("existing viewer assignments survive the Owner migration", async () => {
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_connection_migration: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_connection_migration)
	try {
		const migrator = createMigrator(db, join(import.meta.dirname, "app/database"))
		assertMigrationSucceeded(await migrator.migrateTo("005_polar_customer_state"))
		const app = await db
			.insertInto("app")
			.values({
				owner_organization_id: null,
				owner_user_id: "alice",
				public_hostname: "migration.example.com",
				visibility: "private",
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		await sql`INSERT INTO app_connection_assignment (app_id, user_id, slug, connection_id)
			VALUES (${app.id}, 'alice', 'mail', 'original-account')`.execute(db)
		assertMigrationSucceeded(await migrator.migrateToLatest())
		expect(
			await db.selectFrom("app_connection_assignment").selectAll().execute(),
		).toEqual([
			{
				app_id: app.id,
				connection_id: "original-account",
				owner_id: "alice",
				owner_type: "user",
				slug: "mail",
			},
		])
	} finally {
		await db.destroy()
		await databases.dropAll()
	}
})

test("configuration includes agent-only connections while app execution uses its own resources", async () => {
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_connection_consumers: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_connection_consumers)
	const resources = collectAppResources(
		appSlatesSchema.parse({
			agents: {
				"daily-summary": {
					connections: {
						mail: { mode: "viewer", toolkit: "gmail" },
						repository: { mode: "owner", toolkit: "github" },
					},
				},
			},
			app: { connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
		}),
	)
	const snapshot = {
		commit: "0123456789012345678901234567890123456789",
		resources,
		source: "repository",
	} satisfies ResourcesSnapshot
	const alice = {
		credential: { token: "unused-for-personal-app", type: "access-token" },
		user: { id: "alice" },
	} as const
	try {
		const app = appSchema.parse(
			await db
				.insertInto("app")
				.values({
					owner_organization_id: null,
					owner_user_id: "alice",
					public_hostname: "consumers.example.com",
					visibility: "public",
				})
				.returningAll()
				.executeTakeFirstOrThrow(),
		)
		const access = { app, identity: alice }
		for (const slug of ["mail", "repository"]) {
			expect(
				await assignAppConnection(
					db,
					access,
					"https://auth.example.com",
					assignmentSchema.parse({ connection_id: `alice-${slug}`, slug }),
					snapshot,
				),
			).toEqual({ allowed: true, assignment: { connection_id: `alice-${slug}`, slug } })
		}
		const listed = await listAppConnections(db, access, snapshot)
		expect(listed.connections).toEqual([
			{ connection_id: "alice-mail", mode: "viewer", slug: "mail", toolkit: "gmail" },
			{
				connection_id: "alice-repository",
				mode: "owner",
				slug: "repository",
				toolkit: "github",
			},
		])
		expect(appConnectionsSchema.parse(listed).connections).toEqual(listed.connections)
		expect(
			await resolveAppConnection(
				db,
				access,
				"https://auth.example.com",
				assignmentSchema.shape.slug.parse("mail"),
				snapshot,
			),
		).toEqual({
			allowed: true,
			connection_id: "alice-mail",
			owner: { id: "alice", type: "user" },
			requirement: {
				consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
				mode: "viewer",
				toolkit: "gmail",
			},
		})
		expect(
			await resolveAppConnection(
				db,
				access,
				"https://auth.example.com",
				assignmentSchema.shape.slug.parse("repository"),
				snapshot,
			),
		).toEqual({ allowed: false, reason: "not-found" })
	} finally {
		await db.destroy()
		await databases.dropAll()
	}
})

test("manifest modes select viewer and app Owner assignments through the production operations", async () => {
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_connection_modes: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_connection_modes)
	const manifest = slateSchema.parse({
		connections: {
			company: { mode: "owner", toolkit: "gmail" },
			personal: { mode: "viewer", toolkit: "gmail" },
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" },
			PERSONAL_API_KEY: { mode: "viewer" },
		},
	})
	const resources = collectAppResources({ agents: {}, app: manifest })
	const snapshot = { resources, source: "local" } satisfies ResourcesSnapshot
	const alice = {
		credential: { token: "unused-for-local-personal-app", type: "access-token" },
		user: { id: "alice" },
	} as const
	const bob = { ...alice, user: { id: "bob" } }
	try {
		const app = appSchema.parse(
			await db
				.insertInto("app")
				.values({
					owner_organization_id: null,
					owner_user_id: "alice",
					public_hostname: "modes.example.com",
					visibility: "public",
				})
				.returningAll()
				.executeTakeFirstOrThrow(),
		)
		const access = { app, identity: alice }
		for (const slug of ["company", "personal"]) {
			expect(
				await assignAppConnection(
					db,
					access,
					"https://auth.example.com",
					assignmentSchema.parse({ connection_id: `alice-${slug}`, slug }),
					snapshot,
				),
			).toEqual({ allowed: true, assignment: { connection_id: `alice-${slug}`, slug } })
		}
		await sql`INSERT INTO app_connection_assignment (app_id, owner_type, owner_id, slug, connection_id)
			VALUES (${app.id}, 'user', 'bob', 'personal', 'bob-personal')`.execute(db)
		expect(
			(await listAppConnections(db, { app, identity: bob }, snapshot)).connections,
		).toEqual([
			{
				connection_id: "alice-company",
				mode: "owner",
				slug: "company",
				toolkit: "gmail",
			},
			{
				connection_id: "bob-personal",
				mode: "viewer",
				slug: "personal",
				toolkit: "gmail",
			},
		])
		expect(
			await resolveAppConnection(
				db,
				access,
				"https://auth.example.com",
				assignmentSchema.shape.slug.parse("company"),
				snapshot,
			),
		).toEqual({
			allowed: true,
			connection_id: "alice-company",
			owner: { id: "alice", type: "user" },
			requirement: { consumers: [{ type: "app" }], mode: "owner", toolkit: "gmail" },
		})
		expect(
			await assignAppConnection(
				db,
				{ app, identity: bob },
				"https://auth.example.com",
				assignmentSchema.parse({ connection_id: "replacement", slug: "company" }),
				snapshot,
			),
		).toEqual({ allowed: false, reason: "forbidden" })
		const repositorySnapshot = {
			commit: "0123456789012345678901234567890123456789",
			resources,
			source: "repository",
		} satisfies ResourcesSnapshot
		expect(
			await assignAppConnection(
				db,
				{ app, identity: bob },
				"https://auth.example.com",
				assignmentSchema.parse({ connection_id: "bob-personal", slug: "personal" }),
				repositorySnapshot,
			),
		).toEqual({
			allowed: true,
			assignment: { connection_id: "bob-personal", slug: "personal" },
		})
		expect(
			await resolveAppConnection(
				db,
				{ app, identity: bob },
				"https://auth.example.com",
				assignmentSchema.shape.slug.parse("company"),
				repositorySnapshot,
			),
		).toEqual({
			allowed: true,
			connection_id: "alice-company",
			owner: { id: "alice", type: "user" },
			requirement: { consumers: [{ type: "app" }], mode: "owner", toolkit: "gmail" },
		})
		expect(
			await assignAppConnection(
				db,
				{ app, identity: bob },
				"https://auth.example.com",
				assignmentSchema.parse({ connection_id: "replacement", slug: "company" }),
				repositorySnapshot,
			),
		).toEqual({ allowed: false, reason: "forbidden" })
		expect(
			await resolveAppConnection(
				db,
				{ app, identity: bob },
				"https://auth.example.com",
				assignmentSchema.shape.slug.parse("company"),
				snapshot,
			),
		).toEqual({ allowed: false, reason: "forbidden" })
		const organizationApp = appSchema.parse(
			await db
				.insertInto("app")
				.values({
					owner_organization_id: "acme",
					owner_user_id: null,
					public_hostname: "org-modes.example.com",
					visibility: "public",
				})
				.returningAll()
				.executeTakeFirstOrThrow(),
		)
		await sql`INSERT INTO app_connection_assignment (app_id, owner_type, owner_id, slug, connection_id)
			VALUES (${organizationApp.id}, 'organization', 'acme', 'company', 'acme-company')`.execute(
			db,
		)
		expect(
			(await listAppConnections(db, { app: organizationApp, identity: bob }, snapshot))
				.connections,
		).toEqual([
			{ connection_id: "acme-company", mode: "owner", slug: "company", toolkit: "gmail" },
			{ connection_id: null, mode: "viewer", slug: "personal", toolkit: "gmail" },
		])
		expect(
			Object.values(manifest.secrets).map((requirement) =>
				getCredentialOwner(requirement.mode, organizationApp, bob.user),
			),
		).toEqual([
			{ id: "acme", type: "organization" },
			{ id: "bob", type: "user" },
		])
	} finally {
		await db.destroy()
		await databases.dropAll()
	}
})
