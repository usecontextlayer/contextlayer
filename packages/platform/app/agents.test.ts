import {
	appSlatesSchema,
	collectAppResources,
	resourcesForConsumer,
} from "@usecontextlayer/shared/slate"
import { expect, test } from "vitest"
import { getAgentUnattendedScope } from "@/agent-instance"
import { agentRunRequestSchema, agentRunSchema } from "@/agents.schema"
import { prepareAgentRun } from "@/agents.server"
import { prepareAppResourceConfiguration } from "@/app-resources.server"
import { appSchema } from "@/apps.schema"

test.each([
	{ connections: {}, expected: "app" },
	{ connections: { mail: { mode: "viewer", toolkit: "gmail" } }, expected: "member" },
	{ connections: {}, expected: "member", secrets: { PERSONAL_KEY: { mode: "viewer" } } },
	{ connections: {}, databases: { reports: { mode: "viewer" } }, expected: "member" },
	{
		connections: { repository: { mode: "owner", toolkit: "github" } },
		databases: { reports: { mode: "owner" } },
		expected: "app",
		secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
	},
])(
	"unattended scope is $expected for the agent's own requirements",
	({ expected, ...slate }) => {
		const resources = collectAppResources(
			appSlatesSchema.parse({
				agents: { brief: slate },
				app: { connections: { interactive: { mode: "viewer", toolkit: "gmail" } } },
			}),
		)
		expect(
			getAgentUnattendedScope(
				resourcesForConsumer(resources, { name: "brief", type: "agent" }),
			),
		).toBe(expected)
	},
)

test.each([
	{ id: "alice", type: "user" },
	{ id: "acme", type: "organization" },
] as const)("a published run selects viewer and $type Owner references", (owner) => {
	const app = appSchema.parse({
		id: "00000000-0000-4000-8000-000000000001",
		owner_organization_id: owner.type === "organization" ? owner.id : null,
		owner_user_id: owner.type === "user" ? owner.id : null,
		public_hostname: "brief.contextlayer.xyz",
		visibility: "public",
	})
	const configuration = prepareAppResourceConfiguration(
		app,
		{ id: "bob" },
		resourcesForConsumer(
			collectAppResources(
				appSlatesSchema.parse({
					agents: {
						brief: {
							connections: {},
							databases: { inbox: { mode: "viewer" }, reports: { mode: "owner" } },
							secrets: {
								CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" },
								PERSONAL_API_KEY: { mode: "viewer" },
							},
						},
					},
					app: { connections: {}, databases: { interactive: { mode: "viewer" } } },
				}),
			),
			{ name: "brief", type: "agent" },
		),
		[],
	)
	const prepared = prepareAgentRun(
		app,
		{ id: "bob", type: "user" },
		{ commit: "published-revision", instructions: "Return a company brief.\n" },
		configuration,
		agentRunRequestSchema.parse({ name: "brief", prompt: "Research Acme." }),
	)
	if (!prepared.allowed) throw new Error("Expected a prepared run")
	const run = prepared.run
	expect(run).toEqual({
		actor: { id: "bob", type: "user" },
		agent: {
			commit: "published-revision",
			instructions: "Return a company brief.\n",
			name: "brief",
		},
		appId: "00000000-0000-4000-8000-000000000001",
		connections: {},
		databases: {
			inbox: {
				instance_name: configuration.databases.inbox?.instance_name,
				owner: { id: "bob", type: "user" },
			},
			reports: {
				instance_name: configuration.databases.reports?.instance_name,
				owner,
			},
		},
		prompt: "Research Acme.",
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: owner,
			PERSONAL_API_KEY: { id: "bob", type: "user" },
		},
	})
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run)
	const scheduled = prepareAgentRun(
		app,
		{ type: "app" },
		{ commit: "published-revision", instructions: "Return a company brief.\n" },
		prepareAppResourceConfiguration(
			app,
			null,
			resourcesForConsumer(
				collectAppResources(
					appSlatesSchema.parse({
						agents: {
							brief: {
								connections: {},
								databases: { reports: { mode: "owner" } },
								secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
							},
						},
						app: { connections: {} },
					}),
				),
				{ name: "brief", type: "agent" },
			),
			[],
		),
		{ name: "brief", prompt: "Scheduled research." },
	)
	if (!scheduled.allowed) throw new Error("Expected a prepared scheduled run")
	const unattended = scheduled.run
	expect(unattended.actor).toEqual({ type: "app" })
	expect(unattended.databases).toEqual({ reports: run.databases.reports })
	expect(unattended.secrets).toEqual({ ANTHROPIC_API_KEY: owner })
	expect(unattended.prompt).toBe("Scheduled research.")
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(unattended)))).toEqual(unattended)
})

test("a required connection without an assignment refuses preparation with its own reason", () => {
	const app = appSchema.parse({
		id: "00000000-0000-4000-8000-000000000001",
		owner_organization_id: null,
		owner_user_id: "alice",
		public_hostname: "brief.contextlayer.xyz",
		visibility: "private",
	})
	const configuration = prepareAppResourceConfiguration(
		app,
		{ id: "bob" },
		collectAppResources(
			appSlatesSchema.parse({
				agents: {
					brief: { connections: { mail: { mode: "viewer", toolkit: "gmail" } } },
				},
				app: { connections: {} },
			}),
		),
		[],
	)
	expect(
		prepareAgentRun(
			app,
			{ id: "bob", type: "user" },
			{ commit: "published-revision", instructions: "Return a company brief.\n" },
			configuration,
			{ name: "brief", prompt: "Research Acme." },
		),
	).toEqual({ allowed: false, reason: "connection-assignment-missing" })
})
