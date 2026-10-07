import {
	faCheck,
	faGear,
	faPlus,
	faTriangleExclamation,
} from "@awesome.me/kit-e146ba5a27/icons/slab/regular"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { cn } from "cn"
import { Fragment, type Ref, useState } from "react"
import { Form, useFetcher } from "react-router"
import type { ChromeData, chromeAction } from "@/app-chrome.server"
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

type ChromeProps = {
	connections: ChromeData["connections"]
	toolkits: ChromeData["toolkits"]
	user: ChromeData["user"] | null
	defaultOpen?: boolean
	ref?: Ref<HTMLElement>
}

export function Chrome({
	user,
	connections,
	toolkits,
	defaultOpen = false,
	ref,
}: ChromeProps) {
	const needed = connections.filter(
		(requirement) => requirement.connection_id === null,
	).length
	return (
		<header ref={ref}>
			<Collapsible defaultOpen={defaultOpen}>
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
	requirement: ChromeProps["connections"][number]
	logo: string | undefined
}) {
	const fetcher = useFetcher<typeof chromeAction>()
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
