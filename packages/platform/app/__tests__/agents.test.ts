import {
	collectSlateResources,
	resourcesForConsumer,
	slateDeclarationsSchema,
} from "@usecontextlayer/shared/declaration"
import { expect, test } from "vitest"
import { getAgentUnattendedScope } from "@/agent-instance"
import { prepareAgentConfiguration } from "@/agents.server"
import type { ResolvedSlateResourceConfiguration } from "@/slate-resource-configuration.server"
import { slateSchema } from "@/slates.schema"

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
	({ expected, ...declaration }) => {
		const resources = collectSlateResources(
			slateDeclarationsSchema.parse({
				agents: { brief: declaration },
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

test("prepared agent configuration preserves resolved references and standing instructions", () => {
	const slate = slateSchema.parse({
		id: "00000000-0000-4000-8000-000000000001",
		owner_organization_id: "acme",
		owner_user_id: null,
		public_hostname: "brief.contextlayer.xyz",
		visibility: "private",
	})
	const configuration = {
		connections: {
			repository: {
				account_id: "acme-repository",
				consumers: [{ name: "brief", type: "agent" }],
				mode: "owner",
				owner: { id: "acme", type: "organization" },
				toolkit: "github",
			},
		},
		databases: {
			inbox: {
				consumers: [{ name: "brief", type: "agent" }],
				instance_name: "resolved-bob-inbox",
				mode: "viewer",
				owner: { id: "bob", type: "personal" },
			},
			reports: {
				consumers: [{ name: "brief", type: "agent" }],
				instance_name: "resolved-acme-reports",
				mode: "owner",
				owner: { id: "acme", type: "organization" },
			},
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: {
				consumers: [{ name: "brief", type: "agent" }],
				mode: "owner",
				owner: { id: "acme", type: "organization" },
			},
			PERSONAL_API_KEY: {
				consumers: [{ name: "brief", type: "agent" }],
				mode: "viewer",
				owner: { id: "bob", type: "personal" },
				supplied: true,
			},
		},
	} satisfies ResolvedSlateResourceConfiguration
	const prepared = prepareAgentConfiguration(
		slate,
		{ id: "bob", type: "user" },
		{ commit: "deployed-revision", instructions: "Return a company brief.\n" },
		configuration,
		"brief",
	)
	expect(prepared).toEqual({
		actor: { id: "bob", type: "user" },
		agent: {
			commit: "deployed-revision",
			instructions: "Return a company brief.\n",
			name: "brief",
		},
		connections: {
			repository: {
				account_id: "acme-repository",
				owner: { id: "acme", type: "organization" },
				toolkit: "github",
			},
		},
		databases: {
			inbox: {
				instance_name: "resolved-bob-inbox",
				owner: { id: "bob", type: "personal" },
			},
			reports: {
				instance_name: "resolved-acme-reports",
				owner: { id: "acme", type: "organization" },
			},
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: { id: "acme", type: "organization" },
			PERSONAL_API_KEY: { id: "bob", type: "personal" },
		},
		slateId: "00000000-0000-4000-8000-000000000001",
	})
})
