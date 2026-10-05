import { faAngleDown } from "@awesome.me/kit-e146ba5a27/icons/slab/regular"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { slateSchema } from "@usecontextlayer/shared/slate"
import { Fragment, useCallback } from "react"
import { data } from "react-router"
import { z } from "zod"
import { listAppConnections } from "@/app-connections.server"
import { appTargetSchema } from "@/apps.schema"
import { resolveAppForViewing } from "@/apps.server"
import { getCurrentUser } from "@/auth.server"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { listConnections } from "@/connections.server"
import { appsContext, configContext, databaseContext, identityContext } from "@/context"
import { getAppManifest } from "@/manifest.server"
import { getCredentialOwner, type Owner } from "@/owner"
import type { Route } from "@/routes/+types/chrome"

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store" })

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const parentOrigin = new URL(z.url().parse(url.searchParams.get("parentOrigin"))).origin
	const config = context.get(configContext)
	const issuer = config.CTX_AUTH_ISSUER
	const identity = context.get(identityContext)
	if (!identity)
		return data(
			{ accountLists: [], connections: [], parentOrigin, user: null },
			{ headers: { "Cache-Control": "no-store" } },
		)
	const db = context.get(databaseContext)
	const access = await resolveAppForViewing(
		db,
		appTargetSchema.parse(params.target),
		identity,
		issuer,
	)
	if (!access.allowed)
		throw new Response(null, { status: access.reason === "not-found" ? 404 : 403 })
	const manifestInput = url.searchParams.get("manifest")
	const localManifest = manifestInput
		? slateSchema.parse(JSON.parse(manifestInput))
		: undefined

	const snapshot = await getAppManifest(
		access.app,
		context.get(appsContext),
		localManifest,
	)
	const { connections } = await listAppConnections(
		db,
		{ app: access.app, identity },
		snapshot,
	)
	const requirements = connections.map((requirement) => ({
		...requirement,
		owner: getCredentialOwner(requirement.mode, access.app, identity.user),
	}))
	const owners: Owner[] = []
	for (const { owner } of requirements) {
		if (
			!owners.some((existing) => existing.type === owner.type && existing.id === owner.id)
		)
			owners.push(owner)
	}
	const accountLists = await Promise.all(
		owners.map(async (owner) => {
			const result = await listConnections(config, identity, owner)
			return {
				accounts: result.allowed
					? result.connections.map((account) => ({
							id: account.id,
							label: account.display_name ?? account.alias ?? account.id,
							toolkit: account.toolkit,
						}))
					: null,
				owner,
			}
		}),
	)
	const user = await getCurrentUser(identity, issuer)
	return data(
		{ accountLists, connections: requirements, parentOrigin, user },
		{ headers: { "Cache-Control": "no-store" } },
	)
}

export default function Chrome({
	loaderData: { user, connections, accountLists, parentOrigin },
}: Route.ComponentProps) {
	const requirements = connections
	const connected = requirements.filter(
		(requirement) => requirement.connection_id !== null,
	).length
	const observeHeader = useCallback(
		(element: HTMLElement | null) => {
			if (!element) return
			const observer = new ResizeObserver(() => {
				window.parent.postMessage(
					{ height: element.getBoundingClientRect().height, type: "ctx:chrome:height" },
					parentOrigin,
				)
			})
			observer.observe(element)
			return () => observer.disconnect()
		},
		[parentOrigin],
	)
	return (
		<header
			ref={observeHeader}
			style={{
				colorScheme: "light",
				fontFamily: "ui-sans-serif, system-ui, sans-serif",
				fontSize: 14,
				lineHeight: 1.5,
			}}
		>
			<Collapsible>
				<div className="flex justify-between border-b border-slate-200 bg-slate-100 text-slate-600">
					<span className="shrink-0 px-4 py-[6.5px] font-logo text-[13px]/4 font-normal text-slate-500">
						contextlayer
					</span>
					<span className="flex min-w-0 self-stretch">
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									className="h-auto self-stretch rounded-none border-0 border-l border-slate-200 bg-slate-100 px-3 py-[6.5px] text-[13px]/4 font-normal text-slate-600 hover:bg-slate-200 hover:text-slate-600 aria-expanded:bg-slate-100 aria-expanded:text-slate-600 aria-expanded:hover:bg-slate-200"
								/>
							}
						>
							{connected}/{requirements.length} connected services
						</CollapsibleTrigger>
						<span className="flex min-w-0 items-center gap-2 border-l border-slate-200 py-[3px] pr-3 pl-[3px] text-[13px]/4 font-normal">
							{user ? (
								<>
									<Avatar className="size-[23px] rounded-[3px] after:rounded-[3px]">
										<AvatarImage
											className="rounded-[3px]"
											src={user.image ?? undefined}
											alt=""
										/>
										<AvatarFallback className="rounded-[3px] text-[13px]">
											{user.name.slice(0, 1)}
										</AvatarFallback>
									</Avatar>
									<span
										className="max-w-40 truncate"
										title={user.name}
									>
										{user.name}
									</span>
								</>
							) : (
								<span className="truncate pl-[9px]">Not signed in</span>
							)}
						</span>
					</span>
				</div>
				<CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden bg-slate-100 transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
					<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-b border-slate-200 p-4 text-slate-600">
						{requirements.map((requirement) => {
							const accounts = accountLists.find(
								(list) =>
									list.owner.type === requirement.owner.type &&
									list.owner.id === requirement.owner.id,
							)?.accounts
							const selected = accounts?.find(
								(account) => account.id === requirement.connection_id,
							)
							const choices = accounts?.filter(
								(account) => account.toolkit === requirement.toolkit,
							)
							const label =
								accounts === null
									? "Managed by app owner"
									: (selected?.label ?? requirement.connection_id ?? "Not assigned")
							return (
								<Fragment key={requirement.slug}>
									<div className="min-w-0">
										<p
											className="truncate text-sm font-medium"
											title={requirement.slug}
										>
											{requirement.slug}
										</p>
										<p className="text-xs text-muted-foreground">
											{requirement.toolkit} ·{" "}
											{requirement.mode === "viewer" ? "your account" : "shared"}
										</p>
									</div>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="outline"
													className="w-full min-w-0 justify-between"
												/>
											}
											disabled={accounts === null}
											aria-label={`Account for ${requirement.slug}`}
											title={label}
										>
											<span className="truncate">{label}</span>
											<FontAwesomeIcon
												icon={faAngleDown}
												aria-hidden="true"
											/>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuGroup>
												<DropdownMenuLabel>Connected accounts</DropdownMenuLabel>
												{choices?.length ? (
													<DropdownMenuRadioGroup
														value={requirement.connection_id ?? ""}
														disabled
													>
														{choices.map((account) => (
															<DropdownMenuRadioItem
																key={account.id}
																value={account.id}
																title={account.label}
															>
																<span className="truncate">{account.label}</span>
															</DropdownMenuRadioItem>
														))}
													</DropdownMenuRadioGroup>
												) : (
													<DropdownMenuItem disabled>
														No connected accounts
													</DropdownMenuItem>
												)}
											</DropdownMenuGroup>
										</DropdownMenuContent>
									</DropdownMenu>
								</Fragment>
							)
						})}
						{requirements.length === 0 && (
							<p className="col-span-2 text-sm">No required services.</p>
						)}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</header>
	)
}
