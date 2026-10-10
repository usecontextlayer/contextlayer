import { expect, test } from "vitest"
import { z } from "zod"
import {
	collectSlateResources,
	declarationSchema,
	resourcesForConsumer,
	resourcesSchema,
	slateDeclarationsSchema,
} from "@/lib/declaration"

test("parses resource requirements and permits omitted databases and secrets", () => {
	const declaration = {
		connections: { mail: { mode: "viewer", toolkit: "gmail" } },
		databases: { reports: { mode: "owner" } },
		secrets: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" } },
	}
	expect(declarationSchema.parse(declaration)).toEqual(declaration)
	expect(declarationSchema.parse({ connections: {} })).toEqual({
		connections: {},
		databases: {},
		secrets: {},
	})
})

test.each([
	[
		"database fields",
		{ connections: {}, databases: { reports: { mode: "owner", path: "/reports" } } },
	],
	[
		"declaration fields",
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
])("rejects unknown authored %s", (_name, declaration) => {
	expect(declarationSchema.safeParse(declaration).success).toBe(false)
})

test("collects and selects consumer resources while preserving each declaration", () => {
	const declarations = slateDeclarationsSchema.parse({
		agents: {
			followup: {
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
				databases: { priorities: { mode: "viewer" } },
			},
			summary: {
				connections: {
					mail: { mode: "viewer", toolkit: "gmail" },
					repository: { mode: "owner", toolkit: "github" },
				},
				databases: { priorities: { mode: "viewer" }, reports: { mode: "owner" } },
				secrets: { MODEL_KEY: { mode: "owner" }, SERVICE_KEY: { mode: "owner" } },
			},
		},
		app: {
			connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			databases: { reports: { mode: "owner" } },
			secrets: { SERVICE_KEY: { mode: "owner" } },
		},
	})
	const before = structuredClone(declarations)
	const app = { type: "app" } as const
	const summary = { name: "summary", type: "agent" } as const
	const followup = { name: "followup", type: "agent" } as const
	const resources = collectSlateResources(declarations)
	expect(resourcesSchema.parse(JSON.parse(JSON.stringify(resources)))).toEqual(resources)

	expect(resources).toEqual({
		connections: {
			mail: { consumers: [app, followup, summary], mode: "viewer", toolkit: "gmail" },
			repository: { consumers: [summary], mode: "owner", toolkit: "github" },
		},
		databases: {
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
		databases: { reports: { consumers: [app, summary], mode: "owner" } },
		secrets: { SERVICE_KEY: { consumers: [app, summary], mode: "owner" } },
	})
	expect(resourcesForConsumer(resources, followup)).toEqual({
		connections: {
			mail: { consumers: [app, followup, summary], mode: "viewer", toolkit: "gmail" },
		},
		databases: { priorities: { consumers: [followup, summary], mode: "viewer" } },
		secrets: {},
	})
	expect(resourcesForConsumer(resources, summary)).toEqual(resources)
	expect(declarations).toEqual(before)
})

test("collects a slate with no agents or requirements", () => {
	expect(
		collectSlateResources(
			slateDeclarationsSchema.parse({ agents: {}, app: { connections: {} } }),
		),
	).toEqual({ connections: {}, databases: {}, secrets: {} })
})

test("Resources requires consumer metadata beyond the authored declaration", () => {
	expect(
		resourcesSchema.safeParse(
			declarationSchema.parse({
				connections: { mail: { mode: "viewer", toolkit: "gmail" } },
			}),
		).success,
	).toBe(false)
})

test.each([
	{
		agent: { mode: "viewer", toolkit: "gmail" },
		app: { mode: "owner", toolkit: "gmail" },
		category: "connections",
		key: "mail",
	},
	{
		agent: { mode: "viewer", toolkit: "outlook" },
		app: { mode: "viewer", toolkit: "gmail" },
		category: "connections",
		key: "mail",
	},
	{
		agent: { mode: "viewer" },
		app: { mode: "owner" },
		category: "databases",
		key: "reports",
	},
	{
		agent: { mode: "viewer" },
		app: { mode: "owner" },
		category: "secrets",
		key: "SERVICE_KEY",
	},
])(
	"rejects conflicting $category declarations for $key",
	({ category, key, app, agent }) => {
		const declarations = slateDeclarationsSchema.parse({
			agents: { summary: { connections: {}, [category]: { [key]: agent } } },
			app: { connections: {}, [category]: { [key]: app } },
		})
		expect(() => collectSlateResources(declarations)).toThrowError(z.ZodError)
		expect(() => collectSlateResources(declarations)).toThrowError(
			expect.objectContaining({
				issues: [
					expect.objectContaining({
						code: "custom",
						message: expect.stringContaining(
							`Conflicting ${category} requirement "${key}"`,
						),
						path: ["agents", "summary", category, key],
					}),
				],
			}),
		)
	},
)
