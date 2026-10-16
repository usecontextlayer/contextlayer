import {
	collectSlateResources,
	resourcesForConsumer,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { slateResourceConfigurationSchema } from "@usecontextlayer/shared/slate-resources"
import { expect, test } from "vitest"
import { secretKey } from "@/secrets.server"
import {
	prepareSlateResourceConfiguration,
	resolveSlateResourceConfiguration,
} from "@/slate-resource-configuration.server"
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
			new Set(),
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
	expect(slateResourceConfigurationSchema.parse(configured)).toEqual(configured)
	expect(configured.secrets.PERSONAL_KEY).toMatchObject({
		owner: { id: "bob", type: "personal" },
		supplied: true,
	})
	expect(configured.secrets.SHARED_KEY).toMatchObject({
		owner: { id: "acme", type: "organization" },
	})
	expect(configured.secrets.SHARED_KEY).not.toHaveProperty("supplied")
	expect(resolveSlateResourceConfiguration(configured).allowed).toBe(true)
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
