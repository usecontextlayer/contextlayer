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
import { getCredentialOwner } from "@/owner"
import { assignmentSchema } from "@/slate-connections.schema"
import { assignSlateConnection } from "@/slate-connections.server"
import { slateMemberSchema } from "@/slate-members.schema"
import {
	getSlateResourceConfiguration,
	listSlateConnections,
	listSlateResources,
	resolveSlateConnection,
} from "@/slate-resources.server"
import { slateSchema } from "@/slates.schema"

test("configuration includes agent-only connections while app execution uses its own resources", async ({
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
					secrets: { MODEL_API_KEY: { mode: "owner" }, PERSONAL_KEY: { mode: "viewer" } },
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
		await resolveSlateConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("mail"),
			resources,
		),
	).toEqual({ allowed: false, reason: "connection-required", slug: "mail" })
	for (const slug of ["mail", "repository"]) {
		expect(
			await assignSlateConnection(
				db,
				access,
				"https://auth.example.com",
				assignmentSchema.parse({ connection_id: `alice-${slug}`, slug }),
				resources,
			),
		).toEqual({ allowed: true, assignment: { connection_id: `alice-${slug}`, slug } })
	}
	const listed = await listSlateConnections(db, access, resources)
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
	const configured = await listSlateResources(db, access, resources)
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
		slate,
		null,
		resourcesForConsumer(resources, { name: "nightly", type: "agent" }),
	)
	const prepared = prepareAgentRun(
		slate,
		{ type: "app" },
		{ commit: "deployed-revision", instructions: "Write the nightly report." },
		configuration,
		{ name: "nightly", prompt: "Summarize the repository." },
	)
	if (!prepared.allowed) throw new Error("Expected a prepared scheduled run")
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(prepared.run)))).toEqual({
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
				instance_name: configuration.databases.reports?.instance_name,
				owner: { id: "alice", type: "personal" },
			},
		},
		prompt: "Summarize the repository.",
		secrets: { MODEL_API_KEY: { id: "alice", type: "personal" } },
		slateId: slate.id,
	})
	expect(
		await resolveSlateConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("mail"),
			resources,
		),
	).toEqual({
		allowed: true,
		connection_id: "alice-mail",
		owner: { id: "alice", type: "personal" },
		requirement: {
			consumers: [{ type: "app" }, { name: "daily-summary", type: "agent" }],
			mode: "viewer",
			toolkit: "gmail",
		},
	})
	expect(
		await resolveSlateConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("repository"),
			resources,
		),
	).toEqual({ allowed: false, reason: "not-declared" })
})

test("resource modes select viewer and slate Owner assignments through the hosted operations", async ({
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
	const access = { identity: alice, slate }
	for (const slug of ["company", "personal"]) {
		expect(
			await assignSlateConnection(
				db,
				access,
				"https://auth.example.com",
				assignmentSchema.parse({ connection_id: `alice-${slug}`, slug }),
				resources,
			),
		).toEqual({ allowed: true, assignment: { connection_id: `alice-${slug}`, slug } })
	}
	await db
		.insertInto("slate_member")
		.values(slateMemberSchema.parse({ slate_id: slate.id, user_id: "bob" }))
		.execute()
	await sql`INSERT INTO slate_connection_assignment (slate_id, owner_type, owner_id, slug, connection_id)
		VALUES (${slate.id}, 'personal', 'bob', 'personal', 'bob-personal')`.execute(db)
	expect(
		(await listSlateConnections(db, { identity: bob, slate }, resources)).connections,
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
	expect(
		await resolveSlateConnection(
			db,
			access,
			assignmentSchema.shape.slug.parse("company"),
			resources,
		),
	).toEqual({
		allowed: true,
		connection_id: "alice-company",
		owner: { id: "alice", type: "personal" },
		requirement: { consumers: [{ type: "app" }], mode: "owner", toolkit: "gmail" },
	})
	expect(
		await assignSlateConnection(
			db,
			{ identity: bob, slate },
			"https://auth.example.com",
			assignmentSchema.parse({ connection_id: "replacement", slug: "company" }),
			resources,
		),
	).toEqual({ allowed: false, reason: "forbidden" })
	expect(
		await assignSlateConnection(
			db,
			{ identity: bob, slate },
			"https://auth.example.com",
			assignmentSchema.parse({ connection_id: "bob-personal", slug: "personal" }),
			resources,
		),
	).toEqual({
		allowed: true,
		assignment: { connection_id: "bob-personal", slug: "personal" },
	})
	expect(
		await resolveSlateConnection(
			db,
			{ identity: bob, slate },
			assignmentSchema.shape.slug.parse("company"),
			resources,
		),
	).toEqual({
		allowed: true,
		connection_id: "alice-company",
		owner: { id: "alice", type: "personal" },
		requirement: { consumers: [{ type: "app" }], mode: "owner", toolkit: "gmail" },
	})
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
