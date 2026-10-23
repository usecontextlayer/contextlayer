import {
	faCheck,
	faGear,
	faPlus,
	faTriangleExclamation,
} from "@awesome.me/kit-e146ba5a27/icons/slab/regular"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import type { ResourceConsumer } from "@usecontextlayer/shared/declaration"
import { cn } from "cn"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { data, Form, redirectDocument, useFetcher } from "react-router"
import { z } from "zod"
import { getCurrentUser, type OwnerIdentity } from "@/auth.server"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
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
import { Input } from "@/components/ui/input"
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
import { connectAccount, listConnections, listToolkits } from "@/connections.server"
import {
	agentsContext,
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
	meridianContext,
	sandboxContext,
} from "@/context"
import { getCredentialOwner } from "@/owner"
import type { Route } from "@/routes/+types/chrome"
import { secretSchema, setSecretRequestSchema } from "@/secrets.schema"
import { assignmentSchema } from "@/slate-connections.schema"
import { assignSlateConnection } from "@/slate-connections.server"
import { listSlateResources } from "@/slate-resource-configuration.server"
import { getSlateResources } from "@/slate-resource-execution.server"
import { setSlateSecret } from "@/slate-secrets.server"
import { slateTargetSchema } from "@/slates.schema"
import { resolveSlate, resolveSlateForViewing } from "@/slates.server"

export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
	const policy = loaderHeaders.get("Content-Security-Policy")
	if (policy) actionHeaders.set("Content-Security-Policy", policy)
	actionHeaders.set("Cache-Control", "no-store")
	return actionHeaders
}

function chromeHeaders(parentOrigin: string) {
	return {
		"Cache-Control": "no-store",
		"Content-Security-Policy": `frame-ancestors ${parentOrigin}; base-uri 'none'; object-src 'none'; form-action 'self' https://connect.composio.dev https://dashboard.composio.dev`,
	}
}

const chromeActionSchema = z.discriminatedUnion("intent", [
	assignmentSchema.extend({ intent: z.literal("assign") }),
	assignmentSchema.pick({ slug: true }).extend({ intent: z.literal("connect") }),
	setSecretRequestSchema.extend({
		intent: z.literal("set-secret"),
		name: secretSchema.shape.name,
	}),
])

async function getChromeSlate(
	{ params, context }: Pick<Route.LoaderArgs, "params" | "context">,
	identity: OwnerIdentity,
) {
	const access = await resolveSlateForViewing(
		context.get(databaseContext),
		slateTargetSchema.parse(params.target),
		identity,
		context.get(configContext).CTX_AUTH_ISSUER,
	)
	if (!access.allowed)
		throw new Response(null, { status: access.reason === "not-found" ? 404 : 403 })
	const slateAccess = { identity, slate: access.slate }
	const snapshot = await getSlateResources(slateAccess, context.get(artifactsContext))
	return { access: slateAccess, snapshot }
}

export async function action({ request, params, context }: Route.ActionArgs) {
	const identity = context.get(identityContext)
	if (!identity) throw new Response(null, { status: 401 })
	const form = await request.formData()
	const input = chromeActionSchema.safeParse(Object.fromEntries(form))
	if (!input.success) throw new Response("Invalid configuration action", { status: 400 })
	const { access, snapshot } = await getChromeSlate({ context, params }, identity)
	if (!snapshot.allowed) return data({ reason: snapshot.reason }, { status: 409 })
	const { resources } = snapshot
	if (input.data.intent === "set-secret") {
		const result = await setSlateSecret(
			context.get(databaseContext),
			context.get(artifactsContext),
			context.get(sandboxContext),
			context.get(agentsContext),
			context.get(meridianContext),
			context.get(configContext),
			access,
			input.data.name,
			{ value: input.data.value },
			snapshot,
		)
		if (!result.allowed)
			throw new Response(null, { status: result.reason === "not-found" ? 404 : 403 })
		return result.secret
	}
	if (input.data.intent === "connect") {
		const requirement = resources.connections[input.data.slug]
		if (!requirement) throw new Response(null, { status: 404 })
		const result = await connectAccount(
			context.get(configContext),
			identity,
			getCredentialOwner(requirement.mode, access.slate, identity.user),
			requirement.toolkit,
		)
		if (!result.allowed) throw new Response(null, { status: 403 })
		return redirectDocument(result.link.redirect_url, 303)
	}
	const result = await assignSlateConnection(
		context.get(databaseContext),
		context.get(artifactsContext),
		context.get(sandboxContext),
		context.get(agentsContext),
		context.get(configContext),
		access,
		{ connection_id: input.data.connection_id, slug: input.data.slug },
		snapshot,
	)
	if (!result.allowed)
		throw new Response(null, { status: result.reason === "not-found" ? 404 : 403 })
	return result.assignment
}

export async function loader({ params, context }: Route.LoaderArgs) {
	const config = context.get(configContext)
	const issuer = config.CTX_AUTH_ISSUER
	const identity = context.get(identityContext)
	const db = context.get(databaseContext)
	if (!identity) {
		const slate = await resolveSlate(db, slateTargetSchema.parse(params.target))
		if (!slate) throw new Response(null, { status: 404 })
		const parentOrigin = `https://${slate.public_hostname}`
		return data({ parentOrigin, user: null }, { headers: chromeHeaders(parentOrigin) })
	}
	const { access, snapshot } = await getChromeSlate({ context, params }, identity)
	const parentOrigin = `https://${access.slate.public_hostname}`
	const responseHeaders = chromeHeaders(parentOrigin)
	if (!snapshot.allowed)
		return data(
			{
				configuration: snapshot,
				parentOrigin,
				user: await getCurrentUser(identity, issuer),
			},
			{ headers: responseHeaders },
		)
	const { resources } = await listSlateResources(db, config, access, snapshot.resources)
	const connections = Object.entries(resources.connections)
	const secrets = Object.entries(resources.secrets).flatMap(([name, secret]) =>
		secret.mode === "viewer" ? [{ ...secret, name }] : [],
	)
	const [user, toolkits] = await Promise.all([
		getCurrentUser(identity, issuer),
		connections.length
			? listToolkits(config, [...new Set(connections.map(([, { toolkit }]) => toolkit))])
			: [],
	])
	const accountReads = new Map<string, ReturnType<typeof listConnections>>()
	const requirements = await Promise.all(
		connections.map(async ([slug, { connection_id, ...requirement }]) => {
			const owner = requirement.owner
			const key = `${owner.type}:${owner.id}`
			let accountRead = accountReads.get(key)
			if (!accountRead) {
				accountRead = listConnections(config, identity, owner)
				accountReads.set(key, accountRead)
			}
			const row = {
				...requirement,
				logo: toolkits.find(({ slug }) => slug === requirement.toolkit)?.logo ?? null,
				slug,
			}
			const accountAccess = await accountRead
			if (!accountAccess.allowed) return { ...row, accountAccess }
			const assignedAccount = accountAccess.connections.find(
				({ id }) => id === connection_id,
			)
			return {
				...row,
				accountAccess: {
					accounts: accountAccess.connections.filter(
						({ toolkit }) => toolkit === requirement.toolkit,
					),
					allowed: true as const,
					assignment:
						connection_id === null
							? { type: "unassigned" as const }
							: {
									account: {
										alias: assignedAccount?.alias ?? null,
										display_name: assignedAccount?.display_name ?? null,
										id: connection_id,
									},
									type: "assigned" as const,
								},
				},
			}
		}),
	)
	return data(
		{
			configuration: {
				allowed: true as const,
				connections: requirements,
				secrets,
				unconfiguredCount:
					connections.filter(([, { connection_id }]) => connection_id === null).length +
					secrets.filter(({ supplied }) => !supplied).length,
			},
			parentOrigin,
			user,
		},
		{ headers: responseHeaders },
	)
}

export default function Chrome({ loaderData }: Route.ComponentProps) {
	const { user, parentOrigin } = loaderData
	const configuration = loaderData.user ? loaderData.configuration : undefined
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
						{configuration && !configuration.allowed && (
							<span className="self-center px-3 text-[13px]/4">
								Nothing has been pushed to this slate yet.
							</span>
						)}
						{configuration?.allowed && (
							<CollapsibleTrigger
								render={
									<Button
										variant="ghost"
										className="h-auto self-stretch rounded-none border-0 border-l border-slate-200 bg-slate-100 px-3 py-[6.5px] text-[13px]/4 font-normal text-slate-600 hover:bg-slate-200 hover:text-slate-600 aria-expanded:bg-slate-100 aria-expanded:text-slate-600 aria-expanded:hover:bg-slate-200"
									/>
								}
							>
								<FontAwesomeIcon
									icon={
										configuration.unconfiguredCount === 0
											? faCheck
											: faTriangleExclamation
									}
									className={
										configuration.unconfiguredCount === 0
											? "text-green-600"
											: "text-orange-600"
									}
									aria-hidden="true"
								/>
								{configuration.unconfiguredCount === 0
									? "Setup complete"
									: `${configuration.unconfiguredCount} input${configuration.unconfiguredCount === 1 ? "" : "s"} to configure`}
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
				{configuration?.allowed && (
					<CollapsibleContent
						keepMounted
						className="h-(--collapsible-panel-height) overflow-hidden bg-slate-100 transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
					>
						<ItemGroup className="gap-0 border-b border-slate-200 px-2 py-2">
							{configuration.connections.map((requirement, index) => (
								<Fragment key={requirement.slug}>
									{index > 0 && <ItemSeparator />}
									<ConnectionRow requirement={requirement} />
								</Fragment>
							))}
							{configuration.secrets.map((requirement, index) => (
								<Fragment key={requirement.name}>
									{(configuration.connections.length > 0 || index > 0) && (
										<ItemSeparator />
									)}
									<SecretRow requirement={requirement} />
								</Fragment>
							))}
							{configuration.connections.length === 0 &&
								configuration.secrets.length === 0 && (
									<Item>
										<ItemContent>
											<ItemDescription>No setup required.</ItemDescription>
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
}: {
	requirement: Extract<
		Extract<Route.ComponentProps["loaderData"], { user: object }>["configuration"],
		{ allowed: true }
	>["connections"][number]
}) {
	const fetcher = useFetcher<typeof action>()
	const pending = fetcher.state !== "idle"
	const [open, setOpen] = useState(false)
	const [accountView, setAccountView] = useState<"assignment" | "connect">("assignment")
	const { accountAccess, logo } = requirement
	const title =
		accountView === "connect"
			? "Once you’ve connected your account, refresh this page to assign it."
			: !accountAccess.allowed
				? "Managed by slate Owner"
				: accountAccess.assignment.type === "unassigned"
					? "Not assigned"
					: (accountAccess.assignment.account.display_name ??
						accountAccess.assignment.account.alias ??
						accountAccess.assignment.account.id)

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
							<ResourceConsumers consumers={requirement.consumers} />
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
							<span className={accountView === "connect" ? "wrap-anywhere" : "truncate"}>
								{title}
							</span>
						</ItemTitle>
						{accountView === "assignment" &&
							accountAccess.allowed &&
							accountAccess.assignment.type === "assigned" && (
								<ItemDescription className="wrap-anywhere text-right">
									{accountAccess.assignment.account.alias && (
										<>{accountAccess.assignment.account.alias} · </>
									)}
									{accountAccess.assignment.account.id}
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
			{accountAccess.allowed && (
				<CollapsibleContent keepMounted>
					<div className="flex flex-col gap-4 px-3 pb-4">
						{accountAccess.accounts.length ? (
							<RadioGroup
								aria-label={`Connected accounts for ${requirement.slug}`}
								value={
									accountView === "assignment" &&
									accountAccess.assignment.type === "assigned"
										? accountAccess.assignment.account.id
										: ""
								}
								disabled={pending}
								onValueChange={(connection_id) => {
									setOpen(false)
									setAccountView("assignment")
									if (
										accountAccess.assignment.type === "assigned" &&
										connection_id === accountAccess.assignment.account.id
									)
										return
									fetcher.submit(
										{ connection_id, intent: "assign", slug: requirement.slug },
										{ method: "post" },
									)
								}}
							>
								{accountAccess.accounts.map((account) => (
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
								setAccountView("connect")
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
			)}
		</Collapsible>
	)
}

function ResourceConsumers({ consumers }: { consumers: ResourceConsumer[] }) {
	return (
		<span className="mt-1 flex flex-wrap items-center gap-1.5">
			{consumers.map((consumer) => (
				<Badge
					key={consumer.type === "app" ? "app" : `agent:${consumer.name}`}
					variant="outline"
				>
					{consumer.type === "app" ? "app" : `agent: ${consumer.name}`}
				</Badge>
			))}
		</span>
	)
}

function SecretRow({
	requirement,
}: {
	requirement: Extract<
		Extract<Route.ComponentProps["loaderData"], { user: object }>["configuration"],
		{ allowed: true }
	>["secrets"][number]
}) {
	const fetcher = useFetcher<typeof action>()
	const pending = fetcher.state !== "idle"
	const form = useRef<HTMLFormElement>(null)
	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data && "owner" in fetcher.data)
			form.current?.reset()
	}, [fetcher.state, fetcher.data])
	return (
		<Collapsible>
			<Item className="justify-between">
				<ItemContent className="min-w-0">
					<ItemTitle className="wrap-anywhere">{requirement.name}</ItemTitle>
					<ItemDescription className="line-clamp-none">
						Personal secret
						<ResourceConsumers consumers={requirement.consumers} />
					</ItemDescription>
				</ItemContent>
				<div className="flex shrink-0 items-center gap-2.5">
					<ItemTitle className={pending ? "opacity-50" : undefined}>
						{requirement.supplied ? "Saved" : "Not supplied"}
					</ItemTitle>
					<ItemActions>
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									size="icon"
								/>
							}
							disabled={pending}
							aria-label={`Configure secret ${requirement.name}`}
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
			<CollapsibleContent>
				<fetcher.Form
					ref={form}
					method="post"
					className="flex flex-col items-start gap-3 px-3 pb-4 sm:flex-row sm:items-end"
					aria-busy={pending}
				>
					<input
						type="hidden"
						name="intent"
						value="set-secret"
					/>
					<input
						type="hidden"
						name="name"
						value={requirement.name}
					/>
					<Field className="max-w-xl">
						<FieldLabel htmlFor={`secret-${requirement.name}`}>Secret value</FieldLabel>
						<Input
							id={`secret-${requirement.name}`}
							name="value"
							type="password"
							autoComplete="new-password"
							required
							disabled={pending}
							aria-describedby={`secret-description-${requirement.name}`}
						/>
						<FieldDescription id={`secret-description-${requirement.name}`}>
							Saved for your account and shared with your other slates that request this
							secret.
						</FieldDescription>
					</Field>
					<Button
						type="submit"
						variant="outline"
						disabled={pending}
					>
						{pending ? "Saving…" : "Save secret"}
					</Button>
				</fetcher.Form>
			</CollapsibleContent>
		</Collapsible>
	)
}
