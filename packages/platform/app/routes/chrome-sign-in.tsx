import { useEffect } from "react"
import { data } from "react-router"
import { z } from "zod"
import { credentialHeaders } from "@/auth.server"
import { configContext, identityContext } from "@/context"
import type { Route } from "@/routes/+types/chrome-sign-in"

const responseHeaders = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
}
export const headers: Route.HeadersFunction = () => responseHeaders

export async function loader({ request, context }: Route.LoaderArgs) {
	const state = z.uuid().parse(new URL(request.url).searchParams.get("state"))
	const response = await fetch(
		`${context.get(configContext).CTX_AUTH_ISSUER}/one-time-token/generate`,
		{
			headers: credentialHeaders(context.get(identityContext).credential),
		},
	)
	if (!response.ok) throw new Response("Sign-in failed", { status: response.status })
	const { token } = z.object({ token: z.string().min(1) }).parse(await response.json())
	return data({ state, token }, { headers: responseHeaders })
}

export default function ChromeSignIn({ loaderData }: Route.ComponentProps) {
	useEffect(() => {
		window.opener?.postMessage(loaderData, window.location.origin)
		window.close()
	}, [loaderData])
	return <p>Signed in. You can close this window.</p>
}
