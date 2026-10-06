import { NavLink, Outlet, useMatch, useOutletContext } from "react-router"
import {
	NavigationMenu,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
} from "@/components/ui/navigation-menu"
import type { DashboardData } from "@/routes/dashboard"

export type AppData = Extract<DashboardData, { page: "app" }>
export default function App() {
	const data = useOutletContext<AppData>()
	const { app } = data
	const overview = useMatch("/apps/:appId")
	const views = useMatch("/apps/:appId/views")
	const agents = useMatch("/apps/:appId/agents")
	const resourcesMatch = useMatch("/apps/:appId/resources")
	const deployments = useMatch("/apps/:appId/deployments")
	const settings = useMatch("/apps/:appId/settings")
	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="break-words text-2xl font-semibold tracking-tight">
					{app.public_hostname.replace(/\.contextlayer\.xyz$/, "")}
				</h1>
			</div>
			<div className="overflow-x-auto">
				<NavigationMenu aria-label="App sections">
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
