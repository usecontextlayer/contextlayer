import { randomUUID } from "node:crypto"
import { test } from "@tests/integration"
import { expect } from "vitest"
import { slateSchema } from "@/slates.schema"

test("Owner subscriptions gate execution while declaration access stays available", async ({
	db,
	identity,
	organization,
	platform,
}) => {
	const { origin } = platform
	const { user } = identity
	const personalOwner = user.id
	const organizationOwner = organization.id
	const request = (path: string, init?: RequestInit) => fetch(new URL(path, origin), init)
	const [personalSlate, organizationSlate] = (
		await db
			.insertInto("slate")
			.values([
				{
					owner_organization_id: null,
					owner_user_id: personalOwner,
					public_hostname: "personal.example.com",
					visibility: "public",
				},
				{
					owner_organization_id: organizationOwner,
					owner_user_id: null,
					public_hostname: "organization.example.com",
					visibility: "public",
				},
			])
			.returningAll()
			.execute()
	).map((row) => slateSchema.parse(row))
	if (!personalSlate || !organizationSlate) throw new Error("Expected both test slates")
	const resolve = (hostname: string, pathname: string) =>
		`/api/slates/resolve?${new URLSearchParams({ hostname, pathname })}`
	const expectBlocked = async (slate: typeof personalSlate) => {
		expect((await request(resolve(slate.public_hostname, "/"))).status).toBe(402)
		expect((await request(resolve(slate.public_hostname, "/slate.json"))).status).toBe(
			200,
		)
	}
	const slateWithoutPolarCustomer = slateSchema.parse(
		await db
			.insertInto("slate")
			.values({
				owner_user_id: randomUUID(),
				public_hostname: "missing-customer.example.com",
				visibility: "public",
			})
			.returningAll()
			.executeTakeFirstOrThrow(),
	)
	await expectBlocked(slateWithoutPolarCustomer)
	for (const [slate, owner] of [
		[personalSlate, { id: personalOwner, type: "personal" }],
		[organizationSlate, { id: organizationOwner, type: "organization" }],
	] as const) {
		const response = await request(resolve(slate.public_hostname, "/"))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ id: slate.id, owner })
	}
})
