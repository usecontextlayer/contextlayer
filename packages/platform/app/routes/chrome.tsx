import { chromePath } from "@usecontextlayer/shared/chrome"
import { slateSchema } from "@usecontextlayer/shared/slate"
import { useCallback, useEffect, useRef } from "react"
import { data, useFetcher } from "react-router"
import { z } from "zod"
import { listAppConnections } from "@/app-connections.server"
import { appTargetSchema } from "@/apps.schema"
import { resolveAppForViewing } from "@/apps.server"
import { getCurrentUser } from "@/auth.server"
import { chromeSignInSchema } from "@/chrome.schema"
import { exchangeChromeSession, getChromeIdentity } from "@/chrome-session.server"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { appsContext, configContext, databaseContext } from "@/context"
import { getAppManifest } from "@/manifest.server"
import type { Route } from "@/routes/+types/chrome"

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store" })

export async function action({ request, context }: Route.ActionArgs) {
	if (request.headers.get("Origin") !== new URL(request.url).origin)
		throw new Response(null, { status: 403 })
	const { token } = z.object({ token: z.string().min(1) }).parse(await request.json())
	const cookie = await exchangeChromeSession(
		token,
		context.get(configContext).CTX_AUTH_ISSUER,
	)
	return new Response(null, {
		headers: { "Cache-Control": "no-store", "Set-Cookie": cookie },
		status: 204,
	})
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const parentOrigin = new URL(z.url().parse(url.searchParams.get("parentOrigin"))).origin
	const issuer = context.get(configContext).CTX_AUTH_ISSUER
	const identity = await getChromeIdentity(request, issuer)
	if (!identity)
		return data(
			{ connections: [], parentOrigin, user: null },
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
	const user = await getCurrentUser(identity, issuer)
	return data(
		{ connections, parentOrigin, user },
		{ headers: { "Cache-Control": "no-store" } },
	)
}

export default function Chrome({
	loaderData: { user, connections, parentOrigin },
}: Route.ComponentProps) {
	const requirements = connections
	const connected = requirements.filter(
		(requirement) => requirement.connection_id !== null,
	).length
	const popup = useRef<Window | null>(null)
	const state = useRef<string>(undefined)
	const fetcher = useFetcher()
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
	useEffect(() => {
		function receive(event: MessageEvent) {
			if (
				event.origin !== window.location.origin ||
				!popup.current ||
				event.source !== popup.current
			)
				return
			const message = chromeSignInSchema.safeParse(event.data)
			if (!message.success || message.data.state !== state.current) return
			popup.current = null
			state.current = undefined
			fetcher.submit(
				{ token: message.data.token },
				{ encType: "application/json", method: "post" },
			)
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [fetcher])
	function signIn() {
		state.current = crypto.randomUUID()
		popup.current = window.open(
			`${chromePath}/sign-in?state=${state.current}`,
			"_blank",
			"popup,width=500,height=650",
		)
	}
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
								<button
									type="button"
									className="truncate pl-[9px]"
									onClick={signIn}
									title="Sign in to ContextLayer"
								>
									Not signed in
								</button>
							)}
						</span>
					</span>
				</div>
				<CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden bg-slate-100 transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
					<pre className="overflow-x-auto border-b border-slate-200 p-4 text-xs text-slate-600">
						{JSON.stringify(requirements, null, 2)}
					</pre>
				</CollapsibleContent>
			</Collapsible>
		</header>
	)
}
