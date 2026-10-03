import { exports as entrypoints } from "cloudflare:workers"
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"

export { Tools } from "@/tools"

const resolvedApp = z.object({ id: z.uuid() })

const app = new Hono<{ Bindings: Bindings }>()

app.all("*", async (c) => {
	const env = parseEnv(c.env)
	const session = getCookie(c, "__Secure-ctx_viewer")
	const headers = new Headers()
	const authorization = c.req.header("authorization")
	if (authorization) headers.set("Authorization", authorization)
	if (session) headers.set("Cookie", `__Secure-ctx_viewer=${encodeURIComponent(session)}`)
	const lookup = new URL("/api/apps/resolve", env.CTX_PLATFORM_URL)
	lookup.searchParams.set("hostname", new URL(c.req.url).hostname)
	const response = await fetch(lookup, { headers })
	if (response.status === 401) {
		const signIn = new URL("/start", env.CTX_VIEWER_AUTH_URL)
		signIn.searchParams.set("return_to", c.req.url)
		return c.redirect(signIn.href)
	}
	if (!response.ok) return response
	const { id } = resolvedApp.parse(await response.json())
	const request = new Request(c.req.raw)
	request.headers.delete("authorization")
	const cookies = (request.headers.get("cookie") ?? "")
		.split(";")
		.filter((cookie) => cookie.trim().split("=")[0] !== "__Secure-ctx_viewer")
		.join(";")
	if (cookies) request.headers.set("cookie", cookies)
	else request.headers.delete("cookie")
	const props = session
		? { tools: entrypoints.Tools({ props: { appId: id, sessionToken: session } }) }
		: {}
	return c.env.APPS.get(id, { props }).fetch(request)
})

export default app
