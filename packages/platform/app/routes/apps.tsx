import { faBox, faCode } from "@awesome.me/kit-b228b21a21/icons/slab/regular"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { listApps } from "@/apps.server"
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
import { Separator } from "@/components/ui/separator"
import { artifactsContext, databaseContext } from "@/context"
import type { Route } from "@/routes/+types/apps"

export function meta() {
	return [{ title: "Apps · ContextLayer" }]
}

export async function loader({ context }: Route.LoaderArgs) {
	return {
		apps: await listApps(context.get(databaseContext), context.get(artifactsContext)),
	}
}

export default function Apps({ loaderData: { apps } }: Route.ComponentProps) {
	return (
		<>
			<header className="border-b">
				<div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-6">
					<a
						href="/dashboard/apps"
						className="font-logo text-base font-normal"
					>
						contextlayer
					</a>
					<Separator
						orientation="vertical"
						className="h-4"
					/>
					<span className="text-sm text-muted-foreground">Dashboard</span>
				</div>
			</header>
			<main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
				<div className="space-y-2">
					<div className="flex items-center gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
						<Badge variant="secondary">{apps.length}</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						Create a project with ctx init, then push your code.
					</p>
				</div>
				{apps.length > 0 ? (
					<ItemGroup aria-label="Apps">
						{apps.map((app) => (
							<Item
								key={app.id}
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
										<a
											href={`https://${app.public_hostname}`}
											target="_blank"
											rel="noopener noreferrer"
											className="hover:underline"
										>
											{app.public_hostname.replace(/\.contextlayer\.xyz$/, "")}
										</a>
									</ItemTitle>
									<ItemDescription className="flex items-center gap-2">
										<FontAwesomeIcon
											icon={faCode}
											aria-hidden="true"
										/>
										{app.latest_commit ? (
											<code title={app.latest_commit}>
												{app.latest_commit.slice(0, 7)}
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
							<EmptyTitle>Create your first app</EmptyTitle>
							<EmptyDescription>Create a project from your terminal:</EmptyDescription>
						</EmptyHeader>
						<EmptyContent className="max-w-full">
							<code className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-nowrap">
								ctx init my-app
							</code>
							<p className="text-muted-foreground">
								Your app will appear here after initialization.
							</p>
						</EmptyContent>
					</Empty>
				)}
			</main>
		</>
	)
}
