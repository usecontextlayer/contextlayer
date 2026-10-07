import { data } from "react-router"
import { getAppChrome } from "@/app-chrome.server"
import { appTargetSchema } from "@/apps.schema"
import { Chrome } from "@/components/chrome"
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card"
import {
	artifactsContext,
	configContext,
	databaseContext,
	identityContext,
} from "@/context"
import type { Route } from "@/routes/+types/app-configure"

export { chromeAction as action, chromeHeaders as headers } from "@/app-chrome.server"

export async function loader({ params, context }: Route.LoaderArgs) {
	const identity = context.get(identityContext)
	if (!identity) throw new Response(null, { status: 401 })
	const result = await getAppChrome(
		context.get(databaseContext),
		context.get(configContext),
		context.get(artifactsContext),
		appTargetSchema.parse(params.target),
		identity,
	)
	if (!result.allowed)
		throw new Response(null, { status: result.reason === "not-found" ? 404 : 403 })
	return data(result, { headers: { "Cache-Control": "no-store" } })
}

export default function AppConfigure({ loaderData }: Route.ComponentProps) {
	return (
		<main className="grid min-h-svh place-items-center p-4 sm:p-6">
			<Card className="w-full max-w-2xl bg-slate-100">
				<CardHeader>
					<CardTitle>
						<h1>Configure connections</h1>
					</CardTitle>
					<CardDescription className="wrap-anywhere">
						{loaderData.app.public_hostname}
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4">
					<Chrome
						{...loaderData}
						defaultOpen
					/>
					<p className="text-sm text-muted-foreground">
						When finished, return to the app that brought you here.
					</p>
				</CardContent>
			</Card>
		</main>
	)
}
