import {
	collectSlateResources,
	resourcesForConsumer,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { expect, test } from "vitest"
import { secretKey } from "@/secrets.server"
import { assignmentOwner, assignmentSchema } from "@/slate-connections.schema"
import {
	prepareSlateResourceConfiguration,
	resolveSlateResourceConfiguration,
} from "@/slate-resource-configuration.server"
import { slateSchema } from "@/slates.schema"

test.each([
	{ id: "alice", type: "personal" },
	{ id: "acme", type: "organization" },
] as const)(
	"connections select viewer and $type Owner assignments for each consumer",
	(owner) => {
		const slate = slateSchema.parse({
			id: "00000000-0000-4000-8000-000000000001",
			owner_organization_id: owner.type === "organization" ? owner.id : null,
			owner_user_id: owner.type === "personal" ? owner.id : null,
			public_hostname: "brief.contextlayer.xyz",
			visibility: "private",
		})
		const resources = collectSlateResources(
			slateDeclarationsSchema.parse({
				agents: {
					daily: {
						connections: {
							mail: { mode: "viewer", toolkit: "gmail" },
							repository: { mode: "owner", toolkit: "github" },
						},
					},
					nightly: { connections: { repository: { mode: "owner", toolkit: "github" } } },
				},
				app: { connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
			}),
		)
		const assignments = [
			{
				...assignmentOwner(owner),
				...assignmentSchema.parse({ account_id: "owner-repository", slug: "repository" }),
			},
			{
				...assignmentOwner({ id: "bob", type: "personal" }),
				...assignmentSchema.parse({ account_id: "bob-mail", slug: "mail" }),
			},
			{
				...assignmentOwner({ id: "alice", type: "personal" }),
				...assignmentSchema.parse({ account_id: "alice-mail", slug: "mail" }),
			},
		]
		const configuration = prepareSlateResourceConfiguration(
			slate,
			{ id: "bob" },
			resources,
			assignments,
			new Set(),
		)
		expect(configuration.connections).toEqual({
			mail: {
				account_id: "bob-mail",
				consumers: [{ type: "app" }, { name: "daily", type: "agent" }],
				mode: "viewer",
				owner: { id: "bob", type: "personal" },
				toolkit: "gmail",
			},
			repository: {
				account_id: "owner-repository",
				consumers: [
					{ name: "daily", type: "agent" },
					{ name: "nightly", type: "agent" },
				],
				mode: "owner",
				owner,
				toolkit: "github",
			},
		})
		expect(
			Object.keys(resourcesForConsumer(configuration, { type: "app" }).connections),
		).toEqual(["mail"])
		expect(
			Object.keys(
				resourcesForConsumer(configuration, { name: "nightly", type: "agent" })
					.connections,
			),
		).toEqual(["repository"])
		const anotherViewer = prepareSlateResourceConfiguration(
			slate,
			{ id: "carol" },
			resources,
			assignments,
			new Set(),
		)
		expect(
			resolveSlateResourceConfiguration(
				resourcesForConsumer(anotherViewer, { type: "app" }),
			),
		).toEqual({ allowed: false, reason: "connection-required", slug: "mail" })
		expect(
			resolveSlateResourceConfiguration(
				resourcesForConsumer(anotherViewer, { name: "nightly", type: "agent" }),
			).allowed,
		).toBe(true)
	},
)

test.each([
	{ id: "alice", type: "personal" },
	{ id: "acme", type: "organization" },
] as const)(
	"declared databases belong to their slate and canonical $type Owner",
	(owner) => {
		const slate = slateSchema.parse({
			id: "00000000-0000-4000-8000-000000000001",
			owner_organization_id: owner.type === "organization" ? owner.id : null,
			owner_user_id: owner.type === "personal" ? owner.id : null,
			public_hostname: "brief.contextlayer.xyz",
			visibility: "private",
		})
		const resources = collectSlateResources(
			slateDeclarationsSchema.parse({
				agents: { brief: { connections: {}, databases: { reports: { mode: "owner" } } } },
				app: {
					connections: {},
					databases: { personal: { mode: "viewer" }, reports: { mode: "owner" } },
				},
			}),
		)
		const configuration = prepareSlateResourceConfiguration(
			slate,
			{ id: "bob" },
			resources,
			[],
			new Set(),
		)
		expect(configuration.databases.reports).toMatchObject({
			consumers: [{ type: "app" }, { name: "brief", type: "agent" }],
			mode: "owner",
			owner,
		})
		expect(configuration.databases.personal).toMatchObject({
			consumers: [{ type: "app" }],
			mode: "viewer",
			owner: { id: "bob", type: "personal" },
		})
		const appResources = resourcesForConsumer(configuration, { type: "app" })
		const agentResources = resourcesForConsumer(configuration, {
			name: "brief",
			type: "agent",
		})
		expect(agentResources.databases.reports).toEqual(appResources.databases.reports)
		expect(agentResources.databases.personal).toBeUndefined()
		const anotherMember = prepareSlateResourceConfiguration(
			slate,
			{ id: "carol" },
			resources,
			[],
			new Set(),
		)
		expect(anotherMember.databases.reports).toEqual(configuration.databases.reports)
		expect(anotherMember.databases.personal?.instance_name).not.toBe(
			configuration.databases.personal?.instance_name,
		)
		const anotherSlate = prepareSlateResourceConfiguration(
			{
				...slate,
				id: slateSchema.shape.id.parse("00000000-0000-4000-8000-000000000002"),
			},
			{ id: "bob" },
			resources,
			[],
			new Set(),
		)
		for (const slug of Object.keys(configuration.databases)) {
			expect(anotherSlate.databases[slug]?.instance_name).not.toBe(
				configuration.databases[slug]?.instance_name,
			)
		}
	},
)

test("secret inventory records viewer presence and resolves missing personal input", () => {
	const slate = slateSchema.parse({
		id: "00000000-0000-4000-8000-000000000001",
		owner_organization_id: "acme",
		owner_user_id: null,
		public_hostname: "brief.contextlayer.xyz",
		visibility: "private",
	})
	const resources = collectSlateResources(
		slateDeclarationsSchema.parse({
			agents: {
				brief: {
					connections: {},
					secrets: {
						PERSONAL_KEY: { mode: "viewer" },
						SHARED_KEY: { mode: "owner" },
					},
				},
			},
			app: { connections: {} },
		}),
	)
	const secretNames = new Set([
		secretKey({ id: "bob", type: "personal" }, "PERSONAL_KEY"),
	])
	const configured = prepareSlateResourceConfiguration(
		slate,
		{ id: "bob" },
		resources,
		[],
		secretNames,
	)
	expect(configured.secrets.PERSONAL_KEY).toEqual({
		consumers: [{ name: "brief", type: "agent" }],
		mode: "viewer",
		owner: { id: "bob", type: "personal" },
		supplied: true,
	})
	expect(configured.secrets.SHARED_KEY).toEqual({
		consumers: [{ name: "brief", type: "agent" }],
		mode: "owner",
		owner: { id: "acme", type: "organization" },
	})
	expect(resolveSlateResourceConfiguration(configured)).toEqual({
		allowed: true,
		configuration: configured,
	})
	const anotherViewer = prepareSlateResourceConfiguration(
		slate,
		{ id: "carol" },
		resources,
		[],
		secretNames,
	)
	expect(anotherViewer.secrets.PERSONAL_KEY).toMatchObject({ supplied: false })
	expect(resolveSlateResourceConfiguration(anotherViewer)).toEqual({
		allowed: false,
		name: "PERSONAL_KEY",
		reason: "secret-required",
	})
})
