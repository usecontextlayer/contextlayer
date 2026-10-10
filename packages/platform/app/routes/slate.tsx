import { NavLink, Outlet, useMatch, useOutletContext } from "react-router"
import {
	NavigationMenu,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
} from "@/components/ui/navigation-menu"
import type { DashboardData } from "@/routes/dashboard"

export type SlateData = Extract<DashboardData, { page: "slate" }>
export default function Slate() {
	const data = useOutletContext<SlateData>()
	const { slate } = data
	const overview = useMatch("/slates/:slateId")
	const views = useMatch("/slates/:slateId/views")
	const agents = useMatch("/slates/:slateId/agents")
	const resourcesMatch = useMatch("/slates/:slateId/resources")
	const deployments = useMatch("/slates/:slateId/deployments")
	const settings = useMatch("/slates/:slateId/settings")
	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="break-words text-2xl font-semibold tracking-tight">
					{slate.public_hostname.replace(/\.contextlayer\.xyz$/, "")}
				</h1>
			</div>
			<div className="overflow-x-auto">
				<NavigationMenu aria-label="Slate sections">
					<NavigationMenuList>
						<NavigationMenuItem>
							<NavigationMenuLink
								active={!!overview}
								render={
									<NavLink
										to="."
										end
									/>
								}
							>
								Overview
							</NavigationMenuLink>
						</NavigationMenuItem>
						<NavigationMenuItem>
							<NavigationMenuLink
								active={!!views}
								render={<NavLink to="views" />}
							>
								Views
							</NavigationMenuLink>
						</NavigationMenuItem>
						<NavigationMenuItem>
							<NavigationMenuLink
								active={!!agents}
								render={<NavLink to="agents" />}
							>
								Agents
							</NavigationMenuLink>
						</NavigationMenuItem>
						<NavigationMenuItem>
							<NavigationMenuLink
								active={!!resourcesMatch}
								render={<NavLink to="resources" />}
							>
								Resources
							</NavigationMenuLink>
						</NavigationMenuItem>
						<NavigationMenuItem>
							<NavigationMenuLink
								active={!!deployments}
								render={<NavLink to="deployments" />}
							>
								Deployments
							</NavigationMenuLink>
						</NavigationMenuItem>
						<NavigationMenuItem>
							<NavigationMenuLink
								active={!!settings}
								render={<NavLink to="settings" />}
							>
								Settings
							</NavigationMenuLink>
						</NavigationMenuItem>
					</NavigationMenuList>
				</NavigationMenu>
			</div>
			<Outlet context={data} />
		</>
	)
}
