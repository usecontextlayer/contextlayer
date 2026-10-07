import { appResourceConfigurationSchema } from "@usecontextlayer/shared/app-resources"
import {
	appSlatesSchema,
	collectAppResources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/slate"
import { expect, test } from "vitest"
import { prepareAppResourceConfiguration } from "@/app-resources.server"
import { appSchema } from "@/apps.schema"

test.each([
	{ id: "alice", type: "user" },
	{ id: "acme", type: "organization" },
] as const)("declared folders belong to their app and canonical $type Owner", (owner) => {
	const app = appSchema.parse({
		id: "00000000-0000-4000-8000-000000000001",
		owner_organization_id: owner.type === "organization" ? owner.id : null,
		owner_user_id: owner.type === "user" ? owner.id : null,
		public_hostname: "brief.contextlayer.xyz",
		visibility: "private",
	})
	const resources = collectAppResources(
		appSlatesSchema.parse({
			agents: { brief: { connections: {}, folders: { reports: { mode: "owner" } } } },
			app: {
				connections: {},
				folders: { personal: { mode: "viewer" }, reports: { mode: "owner" } },
			},
		}),
	)
	const configuration = prepareAppResourceConfiguration(app, { id: "bob" }, resources, [])
	expect(appResourceConfigurationSchema.parse(configuration)).toEqual(configuration)
	expect(configuration.folders.reports).toMatchObject({
		consumers: [{ type: "app" }, { name: "brief", type: "agent" }],
		mode: "owner",
		owner,
	})
	expect(configuration.folders.personal).toMatchObject({
		consumers: [{ type: "app" }],
		mode: "viewer",
		owner: { id: "bob", type: "user" },
	})
	const appResources = resourcesForConsumer(configuration, { type: "app" })
	const agentResources = resourcesForConsumer(configuration, {
		name: "brief",
		type: "agent",
	})
	expect(agentResources.folders.reports).toEqual(appResources.folders.reports)
	expect(agentResources.folders.personal).toBeUndefined()
	const anotherMember = prepareAppResourceConfiguration(
		app,
		{ id: "carol" },
		resources,
		[],
	)
	expect(anotherMember.folders.reports).toEqual(configuration.folders.reports)
	expect(anotherMember.folders.personal?.repository_name).not.toBe(
		configuration.folders.personal?.repository_name,
	)
	const anotherApp = prepareAppResourceConfiguration(
		{ ...app, id: appSchema.shape.id.parse("00000000-0000-4000-8000-000000000002") },
		{ id: "bob" },
		resources,
		[],
	)
	for (const slug of Object.keys(configuration.folders)) {
		expect(anotherApp.folders[slug]?.repository_name).not.toBe(
			configuration.folders[slug]?.repository_name,
		)
	}
})
