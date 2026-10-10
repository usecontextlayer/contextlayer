import {
	collectSlateResources,
	resourcesForConsumer,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { expect, test } from "vitest"
import {
	prepareSlateResourceConfiguration,
	resolveSlateResourceActor,
} from "@/slate-resources.server"
import { slateSchema } from "@/slates.schema"

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
		)
		expect(slateResourceConfigurationSchema.parse(configuration)).toEqual(configuration)
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
		)
		for (const slug of Object.keys(configuration.databases)) {
			expect(anotherSlate.databases[slug]?.instance_name).not.toBe(
				configuration.databases[slug]?.instance_name,
			)
		}
	},
)

test.each([
	{ connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
	{ connections: {}, databases: { personal: { mode: "viewer" } } },
	{ connections: {}, secrets: { PERSONAL_KEY: { mode: "viewer" } } },
	{
		connections: { repository: { mode: "owner", toolkit: "github" } },
		databases: { personal: { mode: "viewer" }, reports: { mode: "owner" } },
	},
])("viewer requirements resolve only for a slate member: %j", (declaration) => {
	const resources = collectSlateResources(
		slateDeclarationsSchema.parse({ agents: {}, app: declaration }),
	)
	for (const actor of [{ type: "app" }, { id: "bob", type: "viewer" }] as const)
		expect(resolveSlateResourceActor(actor, resources)).toEqual({
			allowed: false,
			reason: "membership-required",
		})
	const member = { id: "bob", type: "member" } as const
	expect(resolveSlateResourceActor(member, resources)).toEqual({
		allowed: true,
		viewer: member,
	})
})

test("a non-member can resolve resources in owner mode without joining", () => {
	const resources = collectSlateResources(
		slateDeclarationsSchema.parse({
			agents: {},
			app: {
				connections: { repository: { mode: "owner", toolkit: "github" } },
				databases: { reports: { mode: "owner" } },
				secrets: { API_KEY: { mode: "owner" } },
			},
		}),
	)
	const viewer = { id: "bob", type: "viewer" } as const
	expect(resolveSlateResourceActor(viewer, resources)).toEqual({ allowed: true, viewer })
	expect(resolveSlateResourceActor({ type: "app" }, resources)).toEqual({
		allowed: true,
		viewer: null,
	})
})
