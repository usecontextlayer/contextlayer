import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import { expect, test } from "vitest"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"

test("Postgres requires exactly one user or organization owner for each app", async () => {
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_platform_owner_test: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_platform_owner_test)
	try {
		const personal = await db
			.insertInto("app")
			.values({
				owner_organization_id: null,
				owner_user_id: "user-1",
				public_hostname: "personal.example.com",
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		expect(personal.owner_user_id).toBe("user-1")
		expect(personal.owner_organization_id).toBeNull()

		const organization = await db
			.insertInto("app")
			.values({
				owner_organization_id: "org-1",
				owner_user_id: null,
				public_hostname: "organization.example.com",
			})
			.returningAll()
			.executeTakeFirstOrThrow()
		expect(organization.owner_organization_id).toBe("org-1")
		expect(organization.owner_user_id).toBeNull()

		await expect(
			db
				.insertInto("app")
				.values({
					owner_organization_id: null,
					owner_user_id: null,
					public_hostname: "unowned.example.com",
				})
				.execute(),
		).rejects.toMatchObject({ code: "23514" })
		await expect(
			db
				.insertInto("app")
				.values({
					owner_organization_id: "org-1",
					owner_user_id: "user-1",
					public_hostname: "two-owners.example.com",
				})
				.execute(),
		).rejects.toMatchObject({ code: "23514" })
	} finally {
		await db.destroy()
		await databases.dropAll()
	}
})
