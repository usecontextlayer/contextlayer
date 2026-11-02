import { expect, test } from "vitest"
import type { OwnerIdentity } from "@/auth.server"
import { ownerParamsSchema } from "@/owner.schema"
import { slateSchema } from "@/slates.schema"
import { authorizeSlateManagement, authorizeSlateViewing } from "@/slates.server"

test.each([
	{ canonical: "personal", path: "personal" },
	{ canonical: "organization", path: "org" },
])("the $path path selects a canonical $canonical Owner", ({ canonical, path }) => {
	expect(ownerParamsSchema.parse({ owner_id: "selected-owner", type: path })).toEqual({
		owner_id: "selected-owner",
		type: canonical,
	})
})

test.each([
	{
		management: "allowed",
		member: false,
		owner: "personal",
		user: "alice",
		viewing: "allowed",
		visibility: "private",
	},
	{
		management: "forbidden",
		member: false,
		owner: "personal",
		user: "bob",
		viewing: "forbidden",
		visibility: "private",
	},
	{
		management: "sign-in-required",
		member: false,
		owner: "personal",
		user: null,
		viewing: "sign-in-required",
		visibility: "private",
	},
	{
		management: "allowed",
		member: true,
		owner: "organization",
		user: "bob",
		viewing: "allowed",
		visibility: "private",
	},
	{
		management: "forbidden",
		member: false,
		owner: "organization",
		user: "bob",
		viewing: "forbidden",
		visibility: "private",
	},
	{
		management: "sign-in-required",
		member: false,
		owner: "organization",
		user: null,
		viewing: "sign-in-required",
		visibility: "private",
	},
	{
		management: "forbidden",
		member: false,
		owner: "personal",
		user: "bob",
		viewing: "allowed",
		visibility: "public",
	},
	{
		management: "sign-in-required",
		member: false,
		owner: "organization",
		user: null,
		viewing: "allowed",
		visibility: "public",
	},
] as const)(
	"$visibility $owner slate: user=$user member=$member can view=$viewing and manage=$management",
	({ management, member, owner, user, viewing, visibility }) => {
		const slate = slateSchema.parse({
			id: "00000000-0000-4000-8000-000000000001",
			owner_organization_id: owner === "organization" ? "acme" : null,
			owner_user_id: owner === "personal" ? "alice" : null,
			public_hostname: "brief.contextlayer.xyz",
			visibility,
		})
		const identity = user
			? ({
					credential: { cookie: "native-session", type: "cookie" },
					type: "owner",
					user: { id: user },
				} as const satisfies OwnerIdentity)
			: null
		expect(authorizeSlateViewing(slate, identity, member)).toEqual(
			viewing === "allowed"
				? { allowed: true, identity, slate }
				: { allowed: false, reason: viewing },
		)
		expect(authorizeSlateManagement(slate, identity, member)).toEqual(
			management === "allowed"
				? { allowed: true, identity, slate }
				: { allowed: false, reason: management },
		)
	},
)
