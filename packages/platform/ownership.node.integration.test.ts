import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { afterAll, beforeAll, expect, test } from "vitest"
import { DEFAULT_APP_VISIBILITY } from "@/apps.schema"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"

let databases: ProvisionedDatabases<"ctx_platform_owner_test">
let db: ReturnType<typeof createPlatformDb>

beforeAll(async () => {
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_platform_owner_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_platform_owner_test)
})

afterAll(async () => {
	await db?.destroy()
	await databases?.dropAll()
})

test("Postgres requires exactly one user or organization owner for each app", async () => {
	const personal = await db
		.insertInto("app")
		.values({
			owner_organization_id: null,
			owner_user_id: "user-1",
			public_hostname: "personal.example.com",
			visibility: DEFAULT_APP_VISIBILITY,
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
			visibility: DEFAULT_APP_VISIBILITY,
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
				visibility: DEFAULT_APP_VISIBILITY,
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
				visibility: DEFAULT_APP_VISIBILITY,
			})
			.execute(),
	).rejects.toMatchObject({ code: "23514" })
})
