import { test } from "@tests/database"
import { expect } from "vitest"
import { DEFAULT_SLATE_VISIBILITY } from "@/slates.schema"

test("Postgres requires exactly one personal or organization Owner for each slate", async ({
	db,
}) => {
	const personal = await db
		.insertInto("slate")
		.values({
			owner_organization_id: null,
			owner_user_id: "user-1",
			public_hostname: "personal.example.com",
			visibility: DEFAULT_SLATE_VISIBILITY,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	expect(personal.owner_user_id).toBe("user-1")
	expect(personal.owner_organization_id).toBeNull()

	const organization = await db
		.insertInto("slate")
		.values({
			owner_organization_id: "org-1",
			owner_user_id: null,
			public_hostname: "organization.example.com",
			visibility: DEFAULT_SLATE_VISIBILITY,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	expect(organization.owner_organization_id).toBe("org-1")
	expect(organization.owner_user_id).toBeNull()

	await expect(
		db
			.insertInto("slate")
			.values({
				owner_organization_id: null,
				owner_user_id: null,
				public_hostname: "unowned.example.com",
				visibility: DEFAULT_SLATE_VISIBILITY,
			})
			.execute(),
	).rejects.toMatchObject({ code: "23514" })
	await expect(
		db
			.insertInto("slate")
			.values({
				owner_organization_id: "org-1",
				owner_user_id: "user-1",
				public_hostname: "two-owners.example.com",
				visibility: DEFAULT_SLATE_VISIBILITY,
			})
			.execute(),
	).rejects.toMatchObject({ code: "23514" })
})
