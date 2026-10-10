import { expect, test } from "vitest"
import { ownerParamsSchema } from "@/owner.schema"

test.each([
	{ canonical: "personal", path: "personal" },
	{ canonical: "organization", path: "org" },
])("the $path path selects a canonical $canonical Owner", ({ canonical, path }) => {
	expect(ownerParamsSchema.parse({ owner_id: "selected-owner", type: path })).toEqual({
		owner_id: "selected-owner",
		type: canonical,
	})
})
