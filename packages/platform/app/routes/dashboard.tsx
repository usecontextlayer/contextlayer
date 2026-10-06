import { Link, Outlet } from "react-router"
import { appSchema } from "@/apps.schema"
import { getApp, listApps } from "@/apps.server"
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

export async function loader({ context, request, params }: Route.LoaderArgs) {
	const issuer = context.get(configContext).CTX_AUTH_ISSUER
	const identity = context.get(identityContext)
	if (!identity) throw new Response(null, { status: 401 })
	const signIn = new URL("/auth/sign-in", issuer)
	signIn.searchParams.set("redirectTo", request.url)
	const common = { issuer, signInUrl: signIn.href }
	if (params.appId) {
		const id = appSchema.shape.id.safeParse(params.appId)
		if (!id.success) throw new Response("App not found", { status: 404 })
		const result = await getApp(
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
		return { ...common, app: result.app, owner: result.owner, page: "app" as const }
	}
	const organization = params.organizationSlug
		? await findOrganizationBySlug(identity, issuer, params.organizationSlug)
		: undefined
	if (params.organizationSlug && !organization)
		throw new Response("Organization not found", { status: 404 })
	const owner: OwnerDetails = organization
		? { ...organization, type: "organization" }
		: { id: identity.user.id, type: "user" }
	return {
		...common,
		apps: await listApps(
			context.get(databaseContext),
			context.get(artifactsContext),
			identity,
			issuer,
			owner,
		),
		owner,
		page: "apps" as const,
	}
}

export type DashboardData = Awaited<ReturnType<typeof loader>>

export default function Dashboard({ loaderData }: Route.ComponentProps) {
	const { issuer, owner, signInUrl } = loaderData
	const dashboardUrl =
		owner.type === "organization" ? `/org/${owner.slug}/apps` : "/personal/apps"
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
