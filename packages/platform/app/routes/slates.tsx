import { faBox, faCode } from "@awesome.me/kit-e146ba5a27/icons/slab/regular"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { Link, useOutletContext } from "react-router"
import { Badge } from "@/components/ui/badge"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty"
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item"
import type { DashboardData } from "@/routes/dashboard"

export function meta() {
	return [{ title: "Slates · ContextLayer" }]
}

export default function Slates() {
	const { slates, owner } = useOutletContext<Extract<DashboardData, { page: "slates" }>>()
	return (
		<>
			<div className="space-y-2">
				<div className="flex items-center gap-3">
					<h1 className="text-2xl font-semibold tracking-tight">Slates</h1>
					<Badge variant="secondary">{slates.length}</Badge>
				</div>
				<p className="text-sm text-muted-foreground">
					Create a slate with npx @usecontextlayer/cli init, then deploy it with git push.
				</p>
			</div>
			{slates.length > 0 ? (
				<ItemGroup aria-label="Slates">
					{slates.map((slate) => (
						<Item
							key={slate.id}
							variant="outline"
							role="listitem"
						>
							<ItemMedia variant="icon">
								<FontAwesomeIcon
									icon={faBox}
									aria-hidden="true"
								/>
							</ItemMedia>
							<ItemContent>
								<ItemTitle>
									<Link
										to={`/slates/${slate.id}`}
										className="hover:underline"
									>
										{slate.public_hostname.replace(/\.contextlayer\.xyz$/, "")}
									</Link>
								</ItemTitle>
								<ItemDescription className="flex items-center gap-2">
									<FontAwesomeIcon
										icon={faCode}
										aria-hidden="true"
									/>
									{slate.latest_commit ? (
										<code title={slate.latest_commit}>
											{slate.latest_commit.slice(0, 7)}
										</code>
									) : (
										"No commits yet"
									)}
								</ItemDescription>
							</ItemContent>
						</Item>
					))}
				</ItemGroup>
			) : (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FontAwesomeIcon
								icon={faBox}
								aria-hidden="true"
							/>
						</EmptyMedia>
						<EmptyTitle>Create your first slate</EmptyTitle>
						<EmptyDescription>Create a slate from your terminal:</EmptyDescription>
					</EmptyHeader>
					<EmptyContent className="max-w-full">
						<code className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-nowrap">
							{owner.type === "organization"
								? `npx @usecontextlayer/cli init --org ${owner.slug} my-slate`
								: "npx @usecontextlayer/cli init my-slate"}
						</code>
						<p className="text-muted-foreground">
							Your slate will appear here after initialization.
						</p>
					</EmptyContent>
				</Empty>
			)}
		</>
	)
}
