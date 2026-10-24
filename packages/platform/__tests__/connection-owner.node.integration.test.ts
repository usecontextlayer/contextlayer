import { test } from "@tests/database"
import {
	collectSlateResources,
	declarationSchema,
	resourcesForConsumer,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { slateConnectionsSchema } from "@usecontextlayer/shared/slate-connections"
import { sql } from "kysely"
import { expect } from "vitest"
import { agentRunSchema } from "@/agents.schema"
import { prepareAgentRun } from "@/agents.server"
import type { OwnerIdentity } from "@/auth.server"
import { parsePlatformEnv } from "@/env"
import { getCredentialOwner } from "@/owner"
import { slateMemberSchema } from "@/slate-members.schema"
import {
	getSlateResourceConfiguration,
	listSlateConnections,
	listSlateResources,
	resolveSlateResourceConfiguration,
} from "@/slate-resource-configuration.server"
import { slateSchema } from "@/slates.schema"
import { callConnectionTool } from "@/tools.server"

const config = parsePlatformEnv({
	COMPOSIO_API_KEY: "unused-in-sql-only-test",
	CTX_APP_OAUTH_PROVISIONING_SECRET: "unused-in-sql-only-test",
	CTX_PLATFORM_DATABASE_URL: "postgresql://postgres:postgres@localhost/unused",
	POLAR_ACCESS_TOKEN: "unused-in-sql-only-test",
	POLAR_CLIPS_METER_ID: "00000000-0000-4000-8000-000000000001",
	POLAR_ENVIRONMENT: "sandbox",
	POLAR_FREE_PRODUCT_ID: "00000000-0000-4000-8000-000000000002",
	POLAR_WEBHOOK_SECRET: "unused-in-sql-only-test",
})

test("personal-account execution cannot charge another person's public slate", async ({
	db,
}) => {
	const slate = await db
		.insertInto("slate")
		.values({
			owner_user_id: "alice",
			public_hostname: "billing-owner.example.com",
			visibility: "public",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	const bob = {
		credential: { cookie: "unused-for-personal-slate", type: "cookie" },
		type: "owner",
		user: { id: "bob" },
	} as const satisfies OwnerIdentity
	expect(
		await callConnectionTool(db, config, bob, "bob-mail", {
			arguments: {},
			slate_id: slate.id,
			tool: "GMAIL_GET_PROFILE",
			toolkit: "gmail",
		}),
	).toEqual({ allowed: false, reason: "forbidden" })
})

test("configuration includes agent-only connections and projects app requirements", async ({
	db,
}) => {
	const resources = collectSlateResources(
		slateDeclarationsSchema.parse({
			agents: {
				"daily-summary": {
					connections: {
						mail: { mode: "viewer", toolkit: "gmail" },
						repository: { mode: "owner", toolkit: "github" },
					},
					databases: { drafts: { mode: "viewer" }, reports: { mode: "owner" } },
					secrets: { MODEL_API_KEY: { mode: "owner" } },
				},
				nightly: {
					connections: { repository: { mode: "owner", toolkit: "github" } },
					databases: { reports: { mode: "owner" } },
					secrets: { MODEL_API_KEY: { mode: "owner" } },
				},
			},
			app: { connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
		}),
	)
	const alice = {
		credential: { cookie: "unused-for-personal-slate", type: "cookie" },
		type: "owner",
		user: { id: "alice" },
	} as const satisfies OwnerIdentity
	const slate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_organization_id: null,
				owner_user_id: "alice",
				public_hostname: "consumers.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: "alice" }))
		.execute()
	const access = { identity: alice, slate }
	expect(
		resolveSlateResourceConfiguration(
			await getSlateResourceConfiguration(
				db,
				config,
				slate,
				alice.user,
				resourcesForConsumer(resources, { type: "app" }),
			),
		),
	).toEqual({ allowed: false, reason: "connection-required", slug: "mail" })
	await sql`INSERT INTO slate_connection_assignment (slate_id, owner_type, owner_id, slug, connection_id)
 VALUES (${slate.id}, 'personal', 'alice', 'mail', 'alice-mail'), (${slate.id}, 'personal', 'alice', 'repository', 'alice-repository')`.execute(
		db,
	)
	const listed = await listSlateConnections(db, config, access, resources)
	expect(listed.connections).toEqual([
		{
			connection_id: "alice-mail",
			consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
			mode: "viewer",
			owner: { id: "alice", type: "personal" },
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
			owner: { id: "alice", type: "personal" },
			slug: "repository",
			toolkit: "github",
		},
	])
	expect(slateConnectionsSchema.parse(listed).connections).toEqual(listed.connections)
	const appResources = resolveSlateResourceConfiguration(
		await getSlateResourceConfiguration(
			db,
			config,
			slate,
			alice.user,
			resourcesForConsumer(resources, { type: "app" }),
		),
	)
	if (!appResources.allowed) throw new Error("Expected assigned app resources")
	expect(appResources.configuration.connections).toEqual({
		mail: {
			connection_id: "alice-mail",
			consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
			mode: "viewer",
			owner: { id: "alice", type: "personal" },
			toolkit: "gmail",
		},
	})
	const configured = await listSlateResources(db, config, access, resources)
	expect(configured.resources.secrets.MODEL_API_KEY).toEqual({
		consumers: [
			{ name: "daily-summary", type: "agent" },
			{ name: "nightly", type: "agent" },
		],
		mode: "owner",
		owner: { id: "alice", type: "personal" },
	})
	expect(configured.resources.databases).toEqual({
		drafts: {
			consumers: [{ name: "daily-summary", type: "agent" }],
			instance_name: expect.stringMatching(/.+/),
			mode: "viewer",
			owner: { id: "alice", type: "personal" },
		},
		reports: {
			consumers: [
				{ name: "daily-summary", type: "agent" },
				{ name: "nightly", type: "agent" },
			],
			instance_name: expect.stringMatching(/.+/),
			mode: "owner",
			owner: { id: "alice", type: "personal" },
		},
	})
	const configuration = await getSlateResourceConfiguration(
		db,
		config,
		slate,
		null,
		resourcesForConsumer(resources, { name: "nightly", type: "agent" }),
	)
	const resolved = resolveSlateResourceConfiguration(configuration)
	if (!resolved.allowed) throw new Error("Expected complete scheduled resources")
	const prepared = prepareAgentRun(
		slate,
		{ type: "app" },
		{ commit: "deployed-revision", instructions: "Write the nightly report." },
		resolved.configuration,
		{ name: "nightly", prompt: "Summarize the repository." },
	)
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(prepared)))).toEqual({
		actor: { type: "app" },
		agent: {
			commit: "deployed-revision",
			instructions: "Write the nightly report.",
			name: "nightly",
		},
		connections: {
			repository: {
				connection_id: "alice-repository",
				owner: { id: "alice", type: "personal" },
				toolkit: "github",
			},
		},
		databases: {
			reports: {
				instance_name: expect.stringMatching(/.+/),
				owner: { id: "alice", type: "personal" },
			},
		},
		prompt: "Summarize the repository.",
		secrets: { MODEL_API_KEY: { id: "alice", type: "personal" } },
		slateId: slate.id,
	})
})

test("resource modes select viewer and slate Owner assignments in hosted configuration", async ({
	db,
}) => {
	const declaration = declarationSchema.parse({
		connections: {
			company: { mode: "owner", toolkit: "gmail" },
			personal: { mode: "viewer", toolkit: "gmail" },
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" },
			PERSONAL_API_KEY: { mode: "viewer" },
		},
	})
	const resources = collectSlateResources({ agents: {}, app: declaration })
	const alice = {
		credential: { cookie: "unused-for-local-personal-slate", type: "cookie" },
		type: "owner",
		user: { id: "alice" },
	} as const satisfies OwnerIdentity
	const bob = { ...alice, user: { id: "bob" } }
	const slate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_organization_id: null,
				owner_user_id: "alice",
				public_hostname: "modes.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: "alice" }))
		.execute()
	await sql`INSERT INTO slate_connection_assignment (slate_id, owner_type, owner_id, slug, connection_id)
 VALUES (${slate.id}, 'personal', 'alice', 'company', 'alice-company'), (${slate.id}, 'personal', 'alice', 'personal', 'alice-personal')`.execute(
		db,
	)
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: "bob" }))
		.execute()
	await sql`INSERT INTO slate_connection_assignment (slate_id, owner_type, owner_id, slug, connection_id)
		VALUES (${slate.id}, 'personal', 'bob', 'personal', 'bob-personal')`.execute(db)
	expect(
		(await listSlateConnections(db, config, { identity: bob, slate }, resources))
			.connections,
	).toEqual([
		{
			connection_id: "alice-company",
			consumers: [{ type: "app" }],
			mode: "owner",
			owner: { id: "alice", type: "personal" },
			slug: "company",
			toolkit: "gmail",
		},
		{
			connection_id: "bob-personal",
			consumers: [{ type: "app" }],
			mode: "viewer",
			owner: { id: "bob", type: "personal" },
			slug: "personal",
			toolkit: "gmail",
		},
	])
	const organizationSlate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_organization_id: "acme",
				owner_user_id: null,
				public_hostname: "org-modes.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	await sql`INSERT INTO slate_connection_assignment (slate_id, owner_type, owner_id, slug, connection_id)
		VALUES (${organizationSlate.id}, 'organization', 'acme', 'company', 'acme-company')`.execute(
		db,
	)
	expect(
		(
			await listSlateConnections(
				db,
				config,
				{ identity: bob, slate: organizationSlate },
				resources,
			)
		).connections,
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
			owner: { id: "bob", type: "personal" },
			slug: "personal",
			toolkit: "gmail",
		},
	])
	expect(
		Object.values(declaration.secrets).map((requirement) =>
			getCredentialOwner(requirement.mode, organizationSlate, bob.user),
		),
	).toEqual([
		{ id: "acme", type: "organization" },
		{ id: "bob", type: "personal" },
	])
})
