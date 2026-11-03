import { test } from "@tests/database"
import {
	collectSlateResources,
	declarationSchema,
} from "@usecontextlayer/shared/declaration"
import { expect } from "vitest"
import { parsePlatformEnv } from "@/env"
import { assignmentOwner, assignmentSchema } from "@/slate-connections.schema"
import { getSlateResourceConfiguration } from "@/slate-resource-configuration.server"
import { slateSchema } from "@/slates.schema"

const config = parsePlatformEnv({
	COMPOSIO_API_KEY: "unused-in-sql-only-test",
	CTX_APP_OAUTH_PROVISIONING_SECRET: "unused-in-sql-only-test",
	CTX_PLATFORM_DATABASE_URL: "postgresql://postgres:postgres@localhost/unused",
	POLAR_ACCESS_TOKEN: "unused-in-sql-only-test",
	POLAR_CLIPS_METER_ID: "00000000-0000-4000-8000-000000000001",
	POLAR_ENVIRONMENT: "sandbox",
	POLAR_FREE_PRODUCT_ID: "00000000-0000-4000-8000-000000000002",
	POLAR_WEBHOOK_SECRET: "unused-in-sql-only-test",
})

test("configuration reloads viewer connections alongside the organization Owner's saved account", async ({
	db,
}) => {
	const slate = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_organization_id: "acme",
				owner_user_id: null,
				public_hostname: "saved-connections.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	const bob = assignmentOwner({ id: "bob", type: "personal" })
	const mail = assignmentSchema.parse({ account_id: "bob-mail", slug: "mail" })
	await db
		.insertInto("slate_connection_assignment")
		.values([
			{
				...bob,
				...mail,
				slate_id: slate.id,
			},
			{
				...assignmentOwner({ id: "carol", type: "personal" }),
				...assignmentSchema.parse({ account_id: "carol-mail", slug: "mail" }),
				slate_id: slate.id,
			},
			{
				...assignmentOwner({ id: "acme", type: "organization" }),
				...assignmentSchema.parse({
					account_id: "acme-repository",
					slug: "repository",
				}),
				slate_id: slate.id,
			},
		])
		.execute()
	const resources = collectSlateResources({
		agents: {},
		app: declarationSchema.parse({
			connections: {
				mail: { mode: "viewer", toolkit: "gmail" },
				repository: { mode: "owner", toolkit: "github" },
			},
		}),
	})
	for (const [id, account] of [
		["bob", "bob-mail"],
		["carol", "carol-mail"],
	] as const) {
		const configuration = await getSlateResourceConfiguration(
			db,
			config,
			slate,
			{ id },
			resources,
		)
		expect(configuration.connections.mail?.account_id).toBe(account)
		expect(configuration.connections.repository?.account_id).toBe("acme-repository")
	}
	await db
		.updateTable("slate_connection_assignment")
		.set({ account_id: "bob-mail-replaced" })
		.where("slate_id", "=", slate.id)
		.where("owner_type", "=", bob.owner_type)
		.where("owner_id", "=", bob.owner_id)
		.where("slug", "=", mail.slug)
		.execute()
	for (const [id, account] of [
		["bob", "bob-mail-replaced"],
		["carol", "carol-mail"],
	] as const) {
		const configuration = await getSlateResourceConfiguration(
			db,
			config,
			slate,
			{ id },
			resources,
		)
		expect(configuration.connections.mail?.account_id).toBe(account)
		expect(configuration.connections.repository?.account_id).toBe("acme-repository")
	}
})
