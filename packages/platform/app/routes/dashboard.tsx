import { Link, Outlet } from "react-router"
import { findOrganizationBySlug } from "@/auth.server"
import { AuthProvider } from "@/components/auth-provider"
import { OrganizationSwitcher } from "@/components/organization-switcher"
import { Separator } from "@/components/ui/separator"
import { UserMenu } from "@/components/user-menu"
import {
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
} from "@/context"
import type { OwnerDetails } from "@/owner"
import type { Route } from "@/routes/+types/dashboard"
import { slateSchema } from "@/slates.schema"
import { getSlate, listSlates } from "@/slates.server"

export async function loader({ context, request, params }: Route.LoaderArgs) {
	const issuer = context.get(configContext).CTX_AUTH_ISSUER
	const identity = context.get(identityContext)
	if (!identity) throw new Response(null, { status: 401 })
	const signIn = new URL("/auth/sign-in", issuer)
	signIn.searchParams.set("redirectTo", request.url)
	const common = { issuer, signInUrl: signIn.href }
	if (params.slateId) {
		const id = slateSchema.shape.id.safeParse(params.slateId)
		if (!id.success) throw new Response("Slate not found", { status: 404 })
		const result = await getSlate(
			context.get(databaseContext),
			{ id: id.data },
			identity,
			issuer,
		)
		if (!result.allowed) {
			const status = {
				forbidden: 403,
				"not-found": 404,
				"sign-in-required": 401,
			} as const
			throw new Response(null, { status: status[result.reason] })
		}
		return { ...common, owner: result.owner, page: "slate" as const, slate: result.slate }
	}
	const organization = params.organizationSlug
		? await findOrganizationBySlug(identity, issuer, params.organizationSlug)
		: undefined
	if (params.organizationSlug && !organization)
		throw new Response("Organization not found", { status: 404 })
	const owner: OwnerDetails = organization
		? { ...organization, type: "organization" }
		: { id: identity.user.id, type: "personal" }
	return {
		...common,
		owner,
		page: "slates" as const,
		slates: await listSlates(
			context.get(databaseContext),
			context.get(artifactsContext),
			identity,
			issuer,
			owner,
		),
	}
}

export type DashboardData = Awaited<ReturnType<typeof loader>>

export default function Dashboard({ loaderData }: Route.ComponentProps) {
	const { issuer, owner, signInUrl } = loaderData
	const dashboardUrl =
		owner.type === "organization" ? `/org/${owner.slug}/slates` : "/personal/slates"
	return (
		<AuthProvider issuer={issuer}>
			<header className="border-b">
				<div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center gap-3 px-4 py-3 sm:gap-4 sm:px-6">
					<Link
						to={dashboardUrl}
						className="font-logo text-base font-normal"
					>
						contextlayer
					</Link>
					<Separator
						orientation="vertical"
						className="h-4"
					/>
					<Link
						to={dashboardUrl}
						className="text-sm text-muted-foreground"
					>
						Dashboard
					</Link>
					<div className="ml-auto flex items-center gap-3">
						<OrganizationSwitcher owner={owner} />
						<UserMenu signInUrl={signInUrl} />
					</div>
				</div>
			</header>
			<main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
				<Outlet context={loaderData} />
			</main>
		</AuthProvider>
	)
}
