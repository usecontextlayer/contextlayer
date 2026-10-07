import { expect, test } from "vitest"
import { z } from "zod"
import {
	appSlatesSchema,
	collectAppResources,
	resourcesForConsumer,
	resourcesSchema,
	slateSchema,
} from "@/lib/slate"

test("parses resource requirements and permits omitted folders and secrets", () => {
	const manifest = {
		connections: { mail: { mode: "viewer", toolkit: "gmail" } },
		folders: { reports: { mode: "owner" } },
		secrets: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" } },
	}
	expect(slateSchema.parse(manifest)).toEqual(manifest)
	expect(slateSchema.parse({ connections: {} })).toEqual({
		connections: {},
		folders: {},
		secrets: {},
	})
})

test.each([
	[
		"folder fields",
		{ connections: {}, folders: { reports: { mode: "owner", path: "/reports" } } },
	],
	[
		"manifest fields",
		{ connections: {}, secret: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" } } },
	],
	[
		"connection fields",
		{ connections: { mail: { mode: "viewer", scope: "owner", toolkit: "gmail" } } },
	],
	[
		"secret fields",
		{
			connections: {},
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner", owner_id: "alice" } },
		},
	],
])("rejects unknown authored %s", (_name, manifest) => {
	expect(slateSchema.safeParse(manifest).success).toBe(false)
})

test("collects and selects consumer resources while preserving each Slate", () => {
	const slates = appSlatesSchema.parse({
		agents: {
			followup: {
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				folders: { priorities: { mode: "viewer" } },
			},
			summary: {
				connections: {
					mail: { mode: "viewer", toolkit: "gmail" },
					repository: { mode: "owner", toolkit: "github" },
				},
				folders: { priorities: { mode: "viewer" }, reports: { mode: "owner" } },
				secrets: { MODEL_KEY: { mode: "owner" }, SERVICE_KEY: { mode: "owner" } },
			},
		},
		app: {
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			folders: { reports: { mode: "owner" } },
			secrets: { SERVICE_KEY: { mode: "owner" } },
		},
	})
	const before = structuredClone(slates)
	const app = { type: "app" } as const
	const summary = { name: "summary", type: "agent" } as const
	const followup = { name: "followup", type: "agent" } as const
	const resources = collectAppResources(slates)
	expect(resourcesSchema.parse(JSON.parse(JSON.stringify(resources)))).toEqual(resources)

	expect(resources).toEqual({
		connections: {
			mail: { consumers: [app, followup, summary], mode: "viewer", toolkit: "gmail" },
			repository: { consumers: [summary], mode: "owner", toolkit: "github" },
		},
		folders: {
			priorities: { consumers: [followup, summary], mode: "viewer" },
			reports: { consumers: [app, summary], mode: "owner" },
		},
		secrets: {
			MODEL_KEY: { consumers: [summary], mode: "owner" },
			SERVICE_KEY: { consumers: [app, summary], mode: "owner" },
		},
	})
	expect(resourcesForConsumer(resources, app)).toEqual({
		connections: {
			mail: { consumers: [app, followup, summary], mode: "viewer", toolkit: "gmail" },
		},
		folders: { reports: { consumers: [app, summary], mode: "owner" } },
		secrets: { SERVICE_KEY: { consumers: [app, summary], mode: "owner" } },
	})
	expect(resourcesForConsumer(resources, followup)).toEqual({
		connections: {
			mail: { consumers: [app, followup, summary], mode: "viewer", toolkit: "gmail" },
		},
		folders: { priorities: { consumers: [followup, summary], mode: "viewer" } },
		secrets: {},
	})
	expect(resourcesForConsumer(resources, summary)).toEqual(resources)
	expect(slates).toEqual(before)
})

test("collects an app with no agents or requirements", () => {
	expect(
		collectAppResources(appSlatesSchema.parse({ agents: {}, app: { connections: {} } })),
	).toEqual({ connections: {}, folders: {}, secrets: {} })
})

test("MCP tools select their own declared connections from the app-wide collection", () => {
	const resources = collectAppResources(
		appSlatesSchema.parse({
			agents: {},
			app: { connections: { repository: { mode: "owner", toolkit: "github" } } },
			mcp: {
				"fetch-emails": { connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
				"get-time": { connections: {} },
			},
		}),
	)
	expect(resources.connections.mail).toEqual({
		consumers: [{ name: "fetch-emails", type: "mcp" }],
		mode: "viewer",
		toolkit: "gmail",
	})
	expect(
		Object.keys(
			resourcesForConsumer(resources, { name: "fetch-emails", type: "mcp" }).connections,
		),
	).toEqual(["mail"])
	expect(
		resourcesForConsumer(resources, { name: "get-time", type: "mcp" }).connections,
	).toEqual({})
	expect(
		Object.keys(resourcesForConsumer(resources, { type: "app" }).connections),
	).toEqual(["repository"])
})

test("Resources requires consumer metadata beyond the authored Slate", () => {
	expect(
		resourcesSchema.safeParse(
			slateSchema.parse({ connections: { mail: { mode: "viewer", toolkit: "gmail" } } }),
		).success,
	).toBe(false)
})

test.each([
	{
		agent: { mode: "viewer", toolkit: "gmail" },
		app: { mode: "owner", toolkit: "gmail" },
		category: "connections",
		name: "mail",
	},
	{
		agent: { mode: "viewer", toolkit: "outlook" },
		app: { mode: "viewer", toolkit: "gmail" },
		category: "connections",
		name: "mail",
	},
	{
		agent: { mode: "viewer" },
		app: { mode: "owner" },
		category: "folders",
		name: "reports",
	},
	{
		agent: { mode: "viewer" },
		app: { mode: "owner" },
		category: "secrets",
		name: "SERVICE_KEY",
	},
])(
	"rejects conflicting $category declarations for $name",
	({ category, name, app, agent }) => {
		const slates = appSlatesSchema.parse({
			agents: { summary: { connections: {}, [category]: { [name]: agent } } },
			app: { connections: {}, [category]: { [name]: app } },
		})
		expect(() => collectAppResources(slates)).toThrowError(z.ZodError)
		expect(() => collectAppResources(slates)).toThrowError(
			expect.objectContaining({
				issues: [
					expect.objectContaining({
						code: "custom",
						message: expect.stringContaining(
							`Conflicting ${category} requirement "${name}"`,
						),
						path: ["agents", "summary", category, name],
					}),
				],
			}),
		)
	},
)
