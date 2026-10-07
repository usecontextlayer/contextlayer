import { expect, test } from "vitest"
import { assignAppConnectionRequestSchema } from "@/app-connections.schema"
import { appResourcesRequestSchema } from "@/app-resources.schema"
import { personalConnectionsQuerySchema } from "@/connections.schema"
import { connectionToolCallSchema, toolCallSchema } from "@/tools.schema"

const resources = { connections: {}, databases: {}, secrets: {} }
const tool = { arguments: {}, tool: "READ" }

test("hosted requests cannot replace pushed requirements", () => {
	expect(appResourcesRequestSchema.parse({})).toEqual({})
	expect(toolCallSchema.parse({ ...tool, slug: "mail" })).toEqual({
		...tool,
		slug: "mail",
	})
	expect(
		assignAppConnectionRequestSchema.parse({ connection_id: "ca_example", slug: "mail" }),
	).toEqual({ connection_id: "ca_example", slug: "mail" })
	for (const [schema, input] of [
		[appResourcesRequestSchema, {}],
		[toolCallSchema, { ...tool, slug: "mail" }],
		[assignAppConnectionRequestSchema, { connection_id: "ca_example", slug: "mail" }],
	] as const) {
		expect(schema.safeParse({ ...input, resources }).success).toBe(false)
	}
})

test("personal account discovery requires a toolkit and accepts no Owner selector", () => {
	expect(personalConnectionsQuerySchema.parse({ toolkit: "gmail" })).toEqual({
		toolkit: "gmail",
	})
	for (const input of [
		{},
		{ toolkit: "" },
		{ owner_id: "another-user", toolkit: "gmail" },
		{ organization: "acme", toolkit: "gmail" },
	]) {
		expect(personalConnectionsQuerySchema.safeParse(input).success).toBe(false)
	}
})

test("personal execution has app billing context but no declaration or Owner input", () => {
	const call = {
		...tool,
		app_id: "00000000-0000-4000-8000-000000000001",
		toolkit: "gmail",
	}
	expect(connectionToolCallSchema.parse(call)).toEqual(call)
	for (const extra of [
		{ resources },
		{ owner: { id: "acme", type: "organization" } },
		{ mode: "owner" },
		{ slug: "mail" },
	]) {
		expect(connectionToolCallSchema.safeParse({ ...call, ...extra }).success).toBe(false)
	}
	const { app_id: _app, ...withoutApp } = call
	expect(connectionToolCallSchema.safeParse(withoutApp).success).toBe(false)
})
