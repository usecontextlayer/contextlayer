import logoFont from "@fontsource/fugaz-one/files/fugaz-one-latin-400-normal.woff2?url"
import chromeStyles from "@usecontextlayer/sdk/styles.css?inline"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import {
	Links,
	type LoaderFunctionArgs,
	Meta,
	Scripts,
	ScrollRestoration,
	useRouteLoaderData,
} from "react-router"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { viewerContext } from "@/index"
import type { User } from "@/viewer"

export async function loader({ context }: LoaderFunctionArgs) {
	return { user: await context.get(viewerContext).getCurrentUser() }
}

function Chrome({ user }: { user: User | null }) {
	const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null)
	const attach = useCallback((host: HTMLElement | null) => {
		if (host) setShadowRoot(host.shadowRoot ?? host.attachShadow({ mode: "open" }))
	}, [])

	useEffect(() => {
		const font = new FontFace("ContextLayer Logo", `url("${logoFont}")`, {
			display: "swap",
			weight: "400",
		})
		document.fonts.add(font)
		void font.load()
		return () => {
			document.fonts.delete(font)
		}
	}, [])

	return (
		<header ref={attach}>
			{shadowRoot &&
				createPortal(
					<>
						<style>{chromeStyles}</style>
						<Collapsible className="group/chrome">
							<CollapsibleTrigger
								aria-label={
									user
										? `Toggle ContextLayer settings for ${user.name}`
										: "Toggle ContextLayer settings"
								}
								render={
									<Button
										variant="ghost"
										className="h-auto w-full justify-between gap-0 rounded-none border-x-0 border-t-0 border-b-slate-200 bg-slate-100 p-0 text-slate-600 hover:bg-slate-200 hover:text-slate-600 aria-expanded:bg-slate-100 aria-expanded:hover:bg-slate-200"
									/>
								}
							>
								<span className="shrink-0 px-4 py-[6.5px] font-logo text-[13px]/4 font-normal text-slate-500">
									contextlayer
								</span>
								<span className="flex min-w-0 self-stretch">
									<span className="flex shrink-0 items-center px-3 text-[13px]/4 font-normal text-slate-400">
										<span className="group-data-open/chrome:hidden">click to open</span>
										<span className="hidden group-data-open/chrome:inline">
											click to close
										</span>
									</span>
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
							</CollapsibleTrigger>
							<CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden bg-slate-100 transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
								<div className="min-h-40 border-b border-slate-200" />
							</CollapsibleContent>
						</Collapsible>
					</>,
					shadowRoot,
				)}
		</header>
	)
}

export function Layout({ children }: { children: ReactNode }) {
	const data = useRouteLoaderData<typeof loader>("root")
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta
					name="viewport"
					content="width=device-width, initial-scale=1"
				/>
				<Meta />
				<Links />
			</head>
			<body>
				<Chrome user={data?.user ?? null} />
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	)
}
