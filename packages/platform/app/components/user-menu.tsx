import {
	faArrowRightFromBracket,
	faCheck,
	faGear,
	faPlus,
} from "@awesome.me/kit-b228b21a21/icons/slab/regular"
import type { MultiSessionAuthClient } from "@better-auth-ui/core/plugins/multi-session"
import { useAuth, useSession, useSignOut } from "@better-auth-ui/react"
import {
	useListDeviceSessions,
	useSetActiveSession,
} from "@better-auth-ui/react/plugins/multi-session"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { useNavigate } from "react-router"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function UserMenu({ signInUrl }: { signInUrl: string }) {
	const { authClient } = useAuth<MultiSessionAuthClient>()
	const session = useSession(authClient)
	const sessions = useListDeviceSessions(authClient)
	const navigate = useNavigate()
	const switchAccount = useSetActiveSession(authClient, {
		onSuccess: () => navigate("/personal/apps", { replace: true }),
	})
	const signOut = useSignOut(authClient, {
		onSuccess: () => window.location.assign(signInUrl),
	})
	const user = session.data?.user
	const error = session.error ?? sessions.error ?? switchAccount.error ?? signOut.error
	return (
		<div className="ml-auto flex items-center gap-3">
			{error && (
				<p
					role="alert"
					className="text-sm text-destructive"
				>
					{error.message}
				</p>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon"
						/>
					}
					aria-label="Account menu"
					disabled={session.isPending || switchAccount.isPending || signOut.isPending}
				>
					<Avatar>
						<AvatarImage
							src={user?.image ?? undefined}
							alt={user?.name ?? "Account"}
						/>
						<AvatarFallback>{user?.name.slice(0, 1) ?? "?"}</AvatarFallback>
					</Avatar>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="w-64"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>
							<p className="text-sm text-foreground">{user?.name}</p>
							<p className="truncate font-normal">{user?.email}</p>
						</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>Switch account</DropdownMenuLabel>
						{sessions.data?.map(({ session: deviceSession, user: account }) => (
							<DropdownMenuItem
								key={deviceSession.id}
								onClick={() =>
									switchAccount.mutate({ sessionToken: deviceSession.token })
								}
							>
								<div className="min-w-0 flex-1">
									<p>{account.name}</p>
									<p className="truncate text-xs text-muted-foreground">
										{account.email}
									</p>
								</div>
								{account.id === user?.id && (
									<FontAwesomeIcon
										icon={faCheck}
										aria-hidden="true"
									/>
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						render={<a href={new URL("/settings/account", signInUrl).href} />}
					>
						<FontAwesomeIcon
							icon={faGear}
							aria-hidden="true"
						/>
						Settings
					</DropdownMenuItem>
					<DropdownMenuItem render={<a href={signInUrl} />}>
						<FontAwesomeIcon
							icon={faPlus}
							aria-hidden="true"
						/>{" "}
						Add account
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => signOut.mutate()}>
						<FontAwesomeIcon
							icon={faArrowRightFromBracket}
							aria-hidden="true"
						/>{" "}
						Sign out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}
