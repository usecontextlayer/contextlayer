import { appResourceConfigurationSchema } from "@usecontextlayer/shared/app-resources"
import {
	appSlatesSchema,
	collectAppResources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/slate"
import { expect, test } from "vitest"
import {
	prepareAppResourceConfiguration,
	resolveAppResourceActor,
} from "@/app-resources.server"
import { appSchema } from "@/apps.schema"

test.each([
	{ id: "alice", type: "user" },
	{ id: "acme", type: "organization" },
] as const)(
	"declared databases belong to their app and canonical $type Owner",
	(owner) => {
		const app = appSchema.parse({
			id: "00000000-0000-4000-8000-000000000001",
			owner_organization_id: owner.type === "organization" ? owner.id : null,
			owner_user_id: owner.type === "user" ? owner.id : null,
			public_hostname: "brief.contextlayer.xyz",
			visibility: "private",
		})
		const resources = collectAppResources(
			appSlatesSchema.parse({
				agents: { brief: { connections: {}, databases: { reports: { mode: "owner" } } } },
				app: {
					connections: {},
					databases: { personal: { mode: "viewer" }, reports: { mode: "owner" } },
				},
			}),
		)
		const configuration = prepareAppResourceConfiguration(
			app,
			{ id: "bob" },
			resources,
			[],
		)
		expect(appResourceConfigurationSchema.parse(configuration)).toEqual(configuration)
		expect(configuration.databases.reports).toMatchObject({
			consumers: [{ type: "app" }, { name: "brief", type: "agent" }],
			mode: "owner",
			owner,
		})
		expect(configuration.databases.personal).toMatchObject({
			consumers: [{ type: "app" }],
			mode: "viewer",
			owner: { id: "bob", type: "user" },
		})
		const appResources = resourcesForConsumer(configuration, { type: "app" })
		const agentResources = resourcesForConsumer(configuration, {
			name: "brief",
			type: "agent",
		})
		expect(agentResources.databases.reports).toEqual(appResources.databases.reports)
		expect(agentResources.databases.personal).toBeUndefined()
		const anotherMember = prepareAppResourceConfiguration(
			app,
			{ id: "carol" },
			resources,
			[],
		)
		expect(anotherMember.databases.reports).toEqual(configuration.databases.reports)
		expect(anotherMember.databases.personal?.instance_name).not.toBe(
			configuration.databases.personal?.instance_name,
		)
		const anotherApp = prepareAppResourceConfiguration(
			{ ...app, id: appSchema.shape.id.parse("00000000-0000-4000-8000-000000000002") },
			{ id: "bob" },
			resources,
			[],
		)
		for (const slug of Object.keys(configuration.databases)) {
			expect(anotherApp.databases[slug]?.instance_name).not.toBe(
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
])("viewer requirements resolve only for an app member: %j", (slate) => {
	const resources = collectAppResources(appSlatesSchema.parse({ agents: {}, app: slate }))
	for (const actor of [{ type: "app" }, { id: "bob", type: "viewer" }] as const)
		expect(resolveAppResourceActor(actor, resources)).toEqual({
			allowed: false,
			reason: "membership-required",
		})
	const member = { id: "bob", type: "member" } as const
	expect(resolveAppResourceActor(member, resources)).toEqual({
		allowed: true,
		viewer: member,
	})
})

test("a non-member can resolve owner resources without joining", () => {
	const resources = collectAppResources(
		appSlatesSchema.parse({
			agents: {},
			app: {
				connections: { repository: { mode: "owner", toolkit: "github" } },
				databases: { reports: { mode: "owner" } },
				secrets: { API_KEY: { mode: "owner" } },
			},
		}),
	)
	const viewer = { id: "bob", type: "viewer" } as const
	expect(resolveAppResourceActor(viewer, resources)).toEqual({ allowed: true, viewer })
	expect(resolveAppResourceActor({ type: "app" }, resources)).toEqual({
		allowed: true,
		viewer: null,
	})
})
