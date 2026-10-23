import {
	collectSlateResources,
	declarationSchema,
} from "@usecontextlayer/shared/declaration"
import type { SlateDeclarationSnapshot } from "@usecontextlayer/shared/slate-provisioning"
import { describe, expect, test } from "vitest"
import { prepareSlateProvisioning } from "@/slate-provisioning.server"
import { slateSchema } from "@/slates.schema"

const slate = slateSchema.parse({
	id: "79437e47-1e01-49d0-90d8-19d3f0175d9a",
	owner_organization_id: "team",
	owner_user_id: null,
	public_hostname: "provisioning.contextlayer.xyz",
	visibility: "private",
})
const declarations = {
	agents: {
		assistant: declarationSchema.parse({
			connections: {},
			databases: { personal: { mode: "viewer" } },
		}),
	},
	app: declarationSchema.parse({
		connections: {},
		databases: { shared: { mode: "owner" } },
	}),
}
const snapshot: SlateDeclarationSnapshot = {
	agentTrees: [{ hash: "agent-tree", name: "assistant" }],
	allowed: true,
	commit: "selected-commit",
	declarations,
	resources: collectSlateResources(declarations),
}

describe("slate provisioning preparation", () => {
	test("prepares the app and members against one snapshot and deduplicates their database targets", () => {
		const actors = [
			{ type: "app" as const },
			{ id: "alice", type: "user" as const },
			{ id: "bob", type: "user" as const },
			{ id: "alice", type: "user" as const },
		]
		const prepared = prepareSlateProvisioning(slate, actors, snapshot)
		expect(prepared.slate).toEqual({
			id: slate.id,
			owner: { id: "team", type: "organization" },
		})
		expect(prepared.snapshot).toEqual(snapshot)
		expect(prepared.actors).toEqual(actors)
		expect(prepared.databases).toEqual([
			{
				instance_name:
					'["79437e47-1e01-49d0-90d8-19d3f0175d9a","organization","team","shared"]',
				owner: { id: "team", type: "organization" },
				slug: "shared",
			},
			{
				instance_name:
					'["79437e47-1e01-49d0-90d8-19d3f0175d9a","personal","alice","personal"]',
				owner: { id: "alice", type: "personal" },
				slug: "personal",
			},
			{
				instance_name:
					'["79437e47-1e01-49d0-90d8-19d3f0175d9a","personal","bob","personal"]',
				owner: { id: "bob", type: "personal" },
				slug: "personal",
			},
		])
	})

	test("initial membership prepares only the joining member's viewer databases", () => {
		const prepared = prepareSlateProvisioning(
			slate,
			[{ id: "alice", type: "user" }],
			snapshot,
		)
		expect(prepared.databases).toEqual([
			{
				instance_name:
					'["79437e47-1e01-49d0-90d8-19d3f0175d9a","personal","alice","personal"]',
				owner: { id: "alice", type: "personal" },
				slug: "personal",
			},
		])
	})
})
