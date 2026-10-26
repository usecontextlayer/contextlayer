import { expect, test } from "vitest"
import { personalAccountsQuerySchema } from "@/accounts.schema"
import { assignSlateConnectionRequestSchema } from "@/slate-connections.schema"
import { slateResourcesRequestSchema } from "@/slate-resources.schema"
import { accountToolCallSchema, toolCallSchema } from "@/tools.schema"

const resources = { connections: {}, databases: {}, secrets: {} }
const tool = { arguments: {}, tool: "READ" }

test("hosted requests cannot replace pushed requirements", () => {
	expect(slateResourcesRequestSchema.parse({})).toEqual({})
	expect(toolCallSchema.parse({ ...tool, slug: "mail" })).toEqual({
		...tool,
		slug: "mail",
	})
	expect(
		assignSlateConnectionRequestSchema.parse({
			account_id: "ca_example",
			slug: "mail",
		}),
	).toEqual({ account_id: "ca_example", slug: "mail" })
	for (const [schema, input] of [
		[slateResourcesRequestSchema, {}],
		[toolCallSchema, { ...tool, slug: "mail" }],
		[assignSlateConnectionRequestSchema, { account_id: "ca_example", slug: "mail" }],
	] as const) {
		expect(schema.safeParse({ ...input, resources }).success).toBe(false)
	}
})

test("personal connected account discovery requires a toolkit and accepts no Owner selector", () => {
	expect(personalAccountsQuerySchema.parse({ toolkit: "gmail" })).toEqual({
		toolkit: "gmail",
	})
	for (const input of [
		{},
		{ toolkit: "" },
		{ owner_id: "another-user", toolkit: "gmail" },
		{ organization: "acme", toolkit: "gmail" },
	]) {
		expect(personalAccountsQuerySchema.safeParse(input).success).toBe(false)
	}
})

test("personal execution has slate billing context but no declaration or Owner input", () => {
	const call = {
		...tool,
		slate_id: "00000000-0000-4000-8000-000000000001",
		toolkit: "gmail",
	}
	expect(accountToolCallSchema.parse(call)).toEqual(call)
	for (const extra of [
		{ resources },
		{ owner: { id: "acme", type: "organization" } },
		{ mode: "owner" },
		{ slug: "mail" },
	]) {
		expect(accountToolCallSchema.safeParse({ ...call, ...extra }).success).toBe(false)
	}
	const { slate_id: _slate, ...withoutSlate } = call
	expect(accountToolCallSchema.safeParse(withoutSlate).success).toBe(false)
})
