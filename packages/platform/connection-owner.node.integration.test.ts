import { join } from "node:path"
import { assertMigrationSucceeded, createMigrator } from "@usecontextlayer/db-infra"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { appConnectionsSchema } from "@usecontextlayer/shared/app-connections"
import {
	appSlatesSchema,
	collectAppResources,
	resourcesForConsumer,
	slateSchema,
} from "@usecontextlayer/shared/slate"
import { sql } from "kysely"
import { afterEach, beforeEach, expect, test } from "vitest"
import { agentRunSchema } from "@/agents.schema"
import { prepareAgentRun } from "@/agents.server"
import { assignmentSchema } from "@/app-connections.schema"
import { assignAppConnection } from "@/app-connections.server"
import {
	getAppResourceConfiguration,
	listAppConnections,
	listAppResources,
	resolveAppConnection,
} from "@/app-resources.server"
import { appSchema } from "@/apps.schema"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { getCredentialOwner } from "@/owner"

let databases: ProvisionedDatabases<"ctx_connection_test">
let db: ReturnType<typeof createPlatformDb>

beforeEach(async () => {
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_connection_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_connection_test)
})

afterEach(async () => {
	await db?.destroy()
	await databases?.dropAll()
})

test("existing viewer assignments survive the Owner migration", async () => {
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
	expect(await db.selectFrom("app_connection_assignment").selectAll().execute()).toEqual([
		{
			app_id: app.id,
			connection_id: "original-account",
			owner_id: "alice",
			owner_type: "user",
			slug: "mail",
		},
	])
})

test("configuration includes agent-only connections while app execution uses its own resources", async () => {
	const resources = collectAppResources(
		appSlatesSchema.parse({
			agents: {
				"daily-summary": {
					connections: {
						mail: { mode: "viewer", toolkit: "gmail" },
						repository: { mode: "owner", toolkit: "github" },
					},
					folders: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
					secrets: { MODEL_API_KEY: { mode: "owner" }, PERSONAL_KEY: { mode: "viewer" } },
				},
				nightly: {
					connections: { repository: { mode: "owner", toolkit: "github" } },
					folders: { reports: { mode: "owner" } },
					secrets: { MODEL_API_KEY: { mode: "owner" } },
				},
			},
			app: { connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
		}),
	)
	const alice = {
		credential: { token: "unused-for-personal-app", type: "access-token" },
		user: { id: "alice" },
	} as const
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
	expect(
		await resolveAppConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("mail"),
			resources,
		),
	).toEqual({ allowed: false, reason: "connection-required", slug: "mail" })
	for (const slug of ["mail", "repository"]) {
		expect(
			await assignAppConnection(
				db,
				access,
				"https://auth.example.com",
				assignmentSchema.parse({ connection_id: `alice-${slug}`, slug }),
				resources,
			),
		).toEqual({ allowed: true, assignment: { connection_id: `alice-${slug}`, slug } })
	}
	const listed = await listAppConnections(db, access, resources)
	expect(listed.connections).toEqual([
		{
			connection_id: "alice-mail",
			consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
			mode: "viewer",
			owner: { id: "alice", type: "user" },
			slug: "mail",
			toolkit: "gmail",
		},
		{
			connection_id: "alice-repository",
			consumers: [
				{ name: "daily-summary", type: "agent" },
				{ name: "nightly", type: "agent" },
			],
			mode: "owner",
			owner: { id: "alice", type: "user" },
			slug: "repository",
			toolkit: "github",
		},
	])
	expect(appConnectionsSchema.parse(listed).connections).toEqual(listed.connections)
	const configured = await listAppResources(db, access, resources)
	expect(configured.resources.folders).toEqual({
		drafts: {
			consumers: [{ name: "daily-summary", type: "agent" }],
			mode: "viewer",
			owner: { id: "alice", type: "user" },
		},
		reports: {
			consumers: [
				{ name: "daily-summary", type: "agent" },
				{ name: "nightly", type: "agent" },
			],
			mode: "owner",
			owner: { id: "alice", type: "user" },
		},
	})
	const configuration = await getAppResourceConfiguration(
		db,
		app,
		null,
		resourcesForConsumer(resources, { name: "nightly", type: "agent" }),
	)
	const prepared = prepareAgentRun(
		app,
		{ type: "app" },
		{ commit: "published-revision", instructions: "Write the nightly report." },
		configuration,
		{ name: "nightly", prompt: "Summarize the repository." },
	)
	if (!prepared.allowed) throw new Error("Expected a prepared scheduled run")
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(prepared.run)))).toEqual({
		actor: { type: "app" },
		agent: {
			commit: "published-revision",
			instructions: "Write the nightly report.",
			name: "nightly",
		},
		appId: app.id,
		connections: {
			repository: {
				connection_id: "alice-repository",
				owner: { id: "alice", type: "user" },
				toolkit: "github",
			},
		},
		prompt: "Summarize the repository.",
		secrets: { MODEL_API_KEY: { id: "alice", type: "user" } },
	})
	expect(
		await resolveAppConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("mail"),
			resources,
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
			assignmentSchema.shape.slug.parse("repository"),
			resources,
		),
	).toEqual({ allowed: false, reason: "not-found" })
})

test("resource modes select viewer and app Owner assignments through the production operations", async () => {
	const slate = slateSchema.parse({
		connections: {
			company: { mode: "owner", toolkit: "gmail" },
			personal: { mode: "viewer", toolkit: "gmail" },
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" },
			PERSONAL_API_KEY: { mode: "viewer" },
		},
	})
	const resources = collectAppResources({ agents: {}, app: slate })
	const alice = {
		credential: { token: "unused-for-local-personal-app", type: "access-token" },
		user: { id: "alice" },
	} as const
	const bob = { ...alice, user: { id: "bob" } }
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
				resources,
			),
		).toEqual({ allowed: true, assignment: { connection_id: `alice-${slug}`, slug } })
	}
	await sql`INSERT INTO app_connection_assignment (app_id, owner_type, owner_id, slug, connection_id)
		VALUES (${app.id}, 'user', 'bob', 'personal', 'bob-personal')`.execute(db)
	expect(
		(await listAppConnections(db, { app, identity: bob }, resources)).connections,
	).toEqual([
		{
			connection_id: "alice-company",
			consumers: [{ type: "app" }],
			mode: "owner",
			owner: { id: "alice", type: "user" },
			slug: "company",
			toolkit: "gmail",
		},
		{
			connection_id: "bob-personal",
			consumers: [{ type: "app" }],
			mode: "viewer",
			owner: { id: "bob", type: "user" },
			slug: "personal",
			toolkit: "gmail",
		},
	])
	expect(
		await resolveAppConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("company"),
			resources,
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
			resources,
		),
	).toEqual({ allowed: false, reason: "forbidden" })
	expect(
		await assignAppConnection(
			db,
			{ app, identity: bob },
			"https://auth.example.com",
			assignmentSchema.parse({ connection_id: "bob-personal", slug: "personal" }),
			resources,
		),
	).toEqual({
		allowed: true,
		assignment: { connection_id: "bob-personal", slug: "personal" },
	})
	expect(
		await resolveAppConnection(
			db,
			{ app, identity: bob },
			assignmentSchema.shape.slug.parse("company"),
			resources,
		),
	).toEqual({
		allowed: true,
		connection_id: "alice-company",
		owner: { id: "alice", type: "user" },
		requirement: { consumers: [{ type: "app" }], mode: "owner", toolkit: "gmail" },
	})
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
		(await listAppConnections(db, { app: organizationApp, identity: bob }, resources))
			.connections,
	).toEqual([
		{
			connection_id: "acme-company",
			consumers: [{ type: "app" }],
			mode: "owner",
			owner: { id: "acme", type: "organization" },
			slug: "company",
			toolkit: "gmail",
		},
		{
			connection_id: null,
			consumers: [{ type: "app" }],
			mode: "viewer",
			owner: { id: "bob", type: "user" },
			slug: "personal",
			toolkit: "gmail",
		},
	])
	expect(
		Object.values(slate.secrets).map((requirement) =>
			getCredentialOwner(requirement.mode, organizationApp, bob.user),
		),
	).toEqual([
		{ id: "acme", type: "organization" },
		{ id: "bob", type: "user" },
	])
})
