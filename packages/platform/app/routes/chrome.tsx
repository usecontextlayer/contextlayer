import {
	faCheck,
	faGear,
	faPlus,
	faTriangleExclamation,
} from "@awesome.me/kit-e146ba5a27/icons/slab/regular"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { slateSchema } from "@usecontextlayer/shared/slate"
import { cn } from "cn"
import { Fragment, useCallback, useState } from "react"
import { data, Form, useFetcher } from "react-router"
import { z } from "zod"
import { assignmentSchema } from "@/app-connections.schema"
import { assignAppConnection, listAppConnections } from "@/app-connections.server"
import { appTargetSchema } from "@/apps.schema"
import { resolveAppForViewing } from "@/apps.server"
import { type AuthIdentity, getCurrentUser } from "@/auth.server"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldLabel,
	FieldTitle,
} from "@/components/ui/field"
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
} from "@/components/ui/item"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { CONNECTION_MODE_LABELS } from "@/connection-labels"
import { authorizeConnection, listConnections, listToolkits } from "@/connections.server"
import { appsContext, configContext, databaseContext, identityContext } from "@/context"
import { getAppManifest } from "@/manifest.server"
import { getCredentialOwner } from "@/owner"
import type { Route } from "@/routes/+types/chrome"

export const headers: Route.HeadersFunction = ({ actionHeaders }) => {
	actionHeaders.set("Cache-Control", "no-store")
	return actionHeaders
}

const chromeActionSchema = z.discriminatedUnion("intent", [
	assignmentSchema.extend({ intent: z.literal("assign") }),
	assignmentSchema.pick({ slug: true }).extend({ intent: z.literal("connect") }),
])

async function getChromeApp(
	{ request, params, context }: Pick<Route.LoaderArgs, "request" | "params" | "context">,
	identity: AuthIdentity,
) {
	const access = await resolveAppForViewing(
		context.get(databaseContext),
		appTargetSchema.parse(params.target),
		identity,
		context.get(configContext).CTX_AUTH_ISSUER,
	)
	if (!access.allowed)
		throw new Response(null, { status: access.reason === "not-found" ? 404 : 403 })
	const manifestInput = new URL(request.url).searchParams.get("manifest")
	const localManifest = manifestInput
		? slateSchema.parse(JSON.parse(manifestInput))
		: undefined
	const snapshot = await getAppManifest(
		access.app,
		context.get(appsContext),
		localManifest,
	)
	return { access: { app: access.app, identity }, snapshot }
}

export async function action({ request, params, context }: Route.ActionArgs) {
	const identity = context.get(identityContext)
	if (!identity) throw new Response(null, { status: 401 })
	const input = chromeActionSchema.safeParse(Object.fromEntries(await request.formData()))
	if (!input.success) throw new Response("Invalid connection action", { status: 400 })
	const { access, snapshot } = await getChromeApp({ context, params, request }, identity)
	if (input.data.intent === "connect") {
		const requirement = snapshot.manifest.connections[input.data.slug]
		if (!requirement) throw new Response(null, { status: 404 })
		const result = await authorizeConnection(
			context.get(configContext),
			identity,
			getCredentialOwner(requirement.mode, access.app, identity.user),
			requirement.toolkit,
		)
		if (!result.allowed) throw new Response(null, { status: 403 })
		return data(null, { headers: { Refresh: `0; url=${result.link.redirect_url}` } })
	}
	const result = await assignAppConnection(
		context.get(databaseContext),
		access,
		context.get(configContext).CTX_AUTH_ISSUER,
		{ connection_id: input.data.connection_id, slug: input.data.slug },
		snapshot,
	)
	if (!result.allowed)
		throw new Response(null, { status: result.reason === "not-found" ? 404 : 403 })
	return result.assignment
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const parentOrigin = new URL(z.url().parse(url.searchParams.get("parentOrigin"))).origin
	const config = context.get(configContext)
	const issuer = config.CTX_AUTH_ISSUER
	const identity = context.get(identityContext)
	if (!identity)
		return data(
			{ connections: [], parentOrigin, toolkits: [], user: null },
			{ headers: { "Cache-Control": "no-store" } },
		)
	const db = context.get(databaseContext)
	const { access, snapshot } = await getChromeApp({ context, params, request }, identity)
	const { connections } = await listAppConnections(db, access, snapshot)
	const accountReads = new Map<string, ReturnType<typeof listConnections>>()
	const requirements = await Promise.all(
		connections.map(async (requirement) => {
			const owner = getCredentialOwner(requirement.mode, access.app, identity.user)
			const key = `${owner.type}:${owner.id}`
			let accountAccess = accountReads.get(key)
			if (!accountAccess) {
				accountAccess = listConnections(config, identity, owner)
				accountReads.set(key, accountAccess)
			}
			return {
				...requirement,
				accountAccess: await accountAccess,
				owner,
			}
		}),
	)
	const [user, toolkits] = await Promise.all([
		getCurrentUser(identity, issuer),
		requirements.length
			? listToolkits(config, [...new Set(requirements.map(({ toolkit }) => toolkit))])
			: [],
	])
	return data(
		{ connections: requirements, parentOrigin, toolkits, user },
		{ headers: { "Cache-Control": "no-store" } },
	)
}

export default function Chrome({
	loaderData: { user, connections, parentOrigin, toolkits },
}: Route.ComponentProps) {
	const needed = connections.filter(
		(requirement) => requirement.connection_id === null,
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
		<header ref={observeHeader}>
			<Collapsible>
				<div className="flex justify-between border-b border-slate-200 bg-slate-100 text-slate-600">
					<span className="shrink-0 px-4 py-[6.5px] font-logo text-[13px]/4 font-normal text-slate-500">
						contextlayer
					</span>
					<span className="flex min-w-0 self-stretch">
						{user && (
							<CollapsibleTrigger
								render={
									<Button
										variant="ghost"
										className="h-auto self-stretch rounded-none border-0 border-l border-slate-200 bg-slate-100 px-3 py-[6.5px] text-[13px]/4 font-normal text-slate-600 hover:bg-slate-200 hover:text-slate-600 aria-expanded:bg-slate-100 aria-expanded:text-slate-600 aria-expanded:hover:bg-slate-200"
									/>
								}
							>
								<FontAwesomeIcon
									icon={needed === 0 ? faCheck : faTriangleExclamation}
									className={needed === 0 ? "text-green-600" : "text-orange-600"}
									aria-hidden="true"
								/>
								{needed === 0
									? "all services connected"
									: `${needed} connection${needed === 1 ? "" : "s"} needed`}
							</CollapsibleTrigger>
						)}
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
				{user && (
					<CollapsibleContent
						keepMounted
						className="h-(--collapsible-panel-height) overflow-hidden bg-slate-100 transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
					>
						<ItemGroup className="gap-0 border-b border-slate-200 px-2 py-2">
							{connections.map((requirement, index) => (
								<Fragment key={requirement.slug}>
									{index > 0 && <ItemSeparator />}
									<ConnectionRow
										requirement={requirement}
										logo={toolkits.find(({ slug }) => slug === requirement.toolkit)?.logo}
									/>
								</Fragment>
							))}
							{connections.length === 0 && (
								<Item>
									<ItemContent>
										<ItemDescription>No required services.</ItemDescription>
									</ItemContent>
								</Item>
							)}
						</ItemGroup>
					</CollapsibleContent>
				)}
			</Collapsible>
		</header>
	)
}

function ConnectionRow({
	requirement,
	logo,
}: {
	requirement: Route.ComponentProps["loaderData"]["connections"][number]
	logo: string | undefined
}) {
	const fetcher = useFetcher<typeof action>()
	const pending = fetcher.state !== "idle"
	const [open, setOpen] = useState(false)
	const [selection, setSelection] = useState<"saved" | "connect">("saved")
	const { accountAccess } = requirement
	const selected = accountAccess.allowed
		? accountAccess.connections.find(({ id }) => id === requirement.connection_id)
		: undefined
	const choices = accountAccess.allowed
		? accountAccess.connections.filter(({ toolkit }) => toolkit === requirement.toolkit)
		: []
	const title =
		selection === "connect"
			? "Once you’ve connected your account, refresh this page to select it."
			: !accountAccess.allowed
				? "Managed by app owner"
				: (selected?.display_name ??
					selected?.alias ??
					requirement.connection_id ??
					"Not assigned")

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
		>
			<Item className="justify-between">
				<div className="flex min-w-0 items-center gap-4">
					{logo && (
						<img
							src={logo}
							alt={requirement.toolkit}
							className="h-auto w-[30px] shrink-0"
						/>
					)}
					<ItemContent className="min-w-0">
						<ItemTitle>{requirement.slug}</ItemTitle>
						<ItemDescription className="line-clamp-none">
							{CONNECTION_MODE_LABELS[requirement.mode]}
						</ItemDescription>
					</ItemContent>
				</div>
				<div className="flex min-w-0 items-center gap-2.5">
					<ItemContent
						className={cn("min-w-0 items-end text-right", pending && "opacity-50")}
					>
						<ItemTitle
							className="max-w-full line-clamp-none"
							title={title}
						>
							<span className={selection === "connect" ? "wrap-anywhere" : "truncate"}>
								{title}
							</span>
						</ItemTitle>
						{selection === "saved" && selected && (
							<ItemDescription className="wrap-anywhere text-right">
								{selected.alias && <>{selected.alias} · </>}
								{selected.id}
							</ItemDescription>
						)}
					</ItemContent>
					<ItemActions>
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									size="icon"
								/>
							}
							disabled={!accountAccess.allowed || pending}
							aria-label={`Configure accounts for ${requirement.slug}`}
						>
							<FontAwesomeIcon
								icon={faGear}
								className="text-base"
								aria-hidden="true"
							/>
						</CollapsibleTrigger>
					</ItemActions>
				</div>
			</Item>
			<CollapsibleContent keepMounted>
				<div className="flex flex-col gap-4 px-3 pb-4">
					{choices.length ? (
						<RadioGroup
							aria-label={`Accounts for ${requirement.slug}`}
							value={selection === "saved" ? (requirement.connection_id ?? "") : ""}
							disabled={pending}
							onValueChange={(connection_id) => {
								setOpen(false)
								setSelection("saved")
								if (connection_id === requirement.connection_id) return
								fetcher.submit(
									{ connection_id, intent: "assign", slug: requirement.slug },
									{ method: "post" },
								)
							}}
						>
							{choices.map((account) => (
								<FieldLabel key={account.id}>
									<Field orientation="horizontal">
										<RadioGroupItem value={account.id} />
										<FieldContent className="min-w-0">
											<FieldTitle className="max-w-full">
												<span className="truncate">
													{account.display_name ?? account.alias ?? account.id}
												</span>
											</FieldTitle>
											<FieldDescription className="wrap-anywhere">
												{account.alias && <>{account.alias} · </>}
												{account.id}
											</FieldDescription>
										</FieldContent>
									</Field>
								</FieldLabel>
							))}
						</RadioGroup>
					) : (
						<FieldDescription>No connected accounts.</FieldDescription>
					)}
					<Form
						method="post"
						target="_blank"
						reloadDocument
						onSubmit={() => {
							setOpen(false)
							setSelection("connect")
						}}
					>
						<input
							type="hidden"
							name="intent"
							value="connect"
						/>
						<input
							type="hidden"
							name="slug"
							value={requirement.slug}
						/>
						<Button
							type="submit"
							variant="outline"
						>
							<FontAwesomeIcon
								icon={faPlus}
								data-icon="inline-start"
								aria-hidden="true"
							/>
							Connect account
						</Button>
					</Form>
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
