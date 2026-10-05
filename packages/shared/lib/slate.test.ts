import { expect, test } from "vitest"
import { slateSchema } from "@/lib/slate"

test("parses declared credential requirements and permits omitted secrets", () => {
	const manifest = {
		connections: { mail: { mode: "viewer", toolkit: "gmail" } },
		secrets: { CLAUDE_CODE_OAUTH_TOKEN: { mode: "owner" } },
	}
	expect(slateSchema.parse(manifest)).toEqual(manifest)
	expect(slateSchema.parse({ connections: {} })).toEqual({
		connections: {},
		secrets: {},
	})
})

test.each([
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
