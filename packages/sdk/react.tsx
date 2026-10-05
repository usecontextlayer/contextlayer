import logoFont from "@fontsource/fugaz-one/files/fugaz-one-latin-400-normal.woff2?url"
import chromeStyles from "@usecontextlayer/sdk/styles.css?inline"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Links, Meta, Scripts, ScrollRestoration } from "react-router"
import { Button } from "@/components/ui/button"
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible"

function Chrome() {
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
								aria-label="Toggle ContextLayer settings"
								render={
									<Button
										variant="ghost"
										className="h-auto w-full justify-between rounded-none border-x-0 border-t-0 border-b-slate-200 bg-slate-100 px-4 py-[6.5px] text-slate-600 hover:bg-slate-200 hover:text-slate-600 aria-expanded:bg-slate-100 aria-expanded:hover:bg-slate-200"
									/>
								}
							>
								<span className="font-logo text-[13px]/4 font-normal text-slate-500">
									contextlayer
								</span>
								<span className="font-logo text-[13px]/4 font-normal text-slate-400">
									<span className="group-data-open/chrome:hidden">click to open</span>
									<span className="hidden group-data-open/chrome:inline">
										click to close
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
				<Chrome />
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	)
}
