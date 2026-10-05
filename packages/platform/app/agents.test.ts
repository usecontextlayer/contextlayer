import { slateSchema } from "@usecontextlayer/shared/slate"
import { expect, test } from "vitest"
import { agentRunRequestSchema, agentRunSchema } from "@/agents.schema"
import { prepareAgentRun } from "@/agents.server"
import { appSchema } from "@/apps.schema"

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
	const run = prepareAgentRun(
		app,
		{ id: "bob", type: "user" },
		{ commit: "published-revision", instructions: "Return a company brief.\n" },
		slateSchema.parse({
			connections: {},
			secrets: {
				CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" },
				PERSONAL_API_KEY: { mode: "viewer" },
			},
		}),
		agentRunRequestSchema.parse({ name: "brief", prompt: "Research Acme." }),
	)
	expect(run).toEqual({
		actor: { id: "bob", type: "user" },
		agent: {
			commit: "published-revision",
			instructions: "Return a company brief.\n",
			name: "brief",
		},
		appId: "00000000-0000-4000-8000-000000000001",
		connections: {},
		prompt: "Research Acme.",
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: owner,
			PERSONAL_API_KEY: { id: "bob", type: "user" },
		},
	})
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run)
	const unattended = prepareAgentRun(
		app,
		{ type: "app" },
		{ commit: "published-revision", instructions: "Return a company brief.\n" },
		slateSchema.parse({
			connections: {},
			secrets: { ANTHROPIC_API_KEY: { mode: "owner" } },
		}),
		{ name: "brief", prompt: "Scheduled research." },
	)
	expect(unattended.actor).toEqual({ type: "app" })
	expect(unattended.secrets).toEqual({ ANTHROPIC_API_KEY: owner })
	expect(unattended.prompt).toBe("Scheduled research.")
	expect(agentRunSchema.parse(JSON.parse(JSON.stringify(unattended)))).toEqual(unattended)
})
