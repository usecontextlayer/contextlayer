import { faAngleDown } from "@awesome.me/kit-b228b21a21/icons/slab/regular"
import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization"
import { useAuth } from "@better-auth-ui/react"
import { useListOrganizations } from "@better-auth-ui/react/plugins/organization"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { OwnerDetails } from "@/owner"

function OwnerLabel({ children }: { children: string }) {
	return <span className="truncate text-sm font-medium">{children}</span>
}

export function OrganizationSwitcher({ owner }: { owner: OwnerDetails }) {
	const { authClient } = useAuth<OrganizationAuthClient>()
	const organizations = useListOrganizations(authClient)
	const label = owner.type === "user" ? "Personal" : owner.name
	return (
		<div>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							className="h-9 px-2"
						/>
					}
					aria-label="Switch workspace"
					disabled={organizations.isPending}
				>
					<OwnerLabel>{label}</OwnerLabel>
					<FontAwesomeIcon
						icon={faAngleDown}
						aria-hidden="true"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="min-w-64"
				>
					<div className="flex h-9 items-center px-2">
						<OwnerLabel>{label}</OwnerLabel>
					</div>
					<DropdownMenuSeparator />
					{owner.type === "organization" && (
						<DropdownMenuItem
							className="h-9 px-2"
							render={<Link to="/personal/apps" />}
						>
							<OwnerLabel>Personal</OwnerLabel>
						</DropdownMenuItem>
					)}
					{organizations.data
						?.filter((item) => owner.type !== "organization" || item.id !== owner.id)
						.map((item) => (
							<DropdownMenuItem
								key={item.id}
								className="h-9 px-2"
								render={<Link to={`/org/${encodeURIComponent(item.slug)}/apps`} />}
							>
								<OwnerLabel>{item.name}</OwnerLabel>
							</DropdownMenuItem>
						))}
				</DropdownMenuContent>
			</DropdownMenu>
			{organizations.error && (
				<p
					role="alert"
					className="text-sm text-destructive"
				>
					{organizations.error.message}
				</p>
			)}
		</div>
	)
}
