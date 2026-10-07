import { useCallback } from "react"
import { data } from "react-router"
import { z } from "zod"
import { getAppChrome } from "@/app-chrome.server"
import { appTargetSchema } from "@/apps.schema"
import { Chrome } from "@/components/chrome"
import {
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
} from "@/context"
import type { Route } from "@/routes/+types/chrome"

export { chromeAction as action, chromeHeaders as headers } from "@/app-chrome.server"

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const parentOrigin = new URL(z.url().parse(url.searchParams.get("parentOrigin"))).origin
	const identity = context.get(identityContext)
	if (!identity)
		return data(
			{ connections: [], parentOrigin, toolkits: [], user: null },
			{ headers: { "Cache-Control": "no-store" } },
		)
	const result = await getAppChrome(
		context.get(databaseContext),
		context.get(configContext),
		context.get(artifactsContext),
		appTargetSchema.parse(params.target),
		identity,
	)
	if (!result.allowed)
		throw new Response(null, { status: result.reason === "not-found" ? 404 : 403 })
	return data({ ...result, parentOrigin }, { headers: { "Cache-Control": "no-store" } })
}

export default function ChromeFrame({ loaderData }: Route.ComponentProps) {
	const observeHeader = useCallback(
		(element: HTMLElement | null) => {
			if (!element) return
			const observer = new ResizeObserver(() => {
				window.parent.postMessage(
					{ height: element.getBoundingClientRect().height, type: "ctx:chrome:height" },
					loaderData.parentOrigin,
				)
			})
			observer.observe(element)
			return () => observer.disconnect()
		},
		[loaderData.parentOrigin],
	)
	return (
		<Chrome
			{...loaderData}
			ref={observeHeader}
		/>
	)
}
