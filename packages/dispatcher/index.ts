import { exports as entrypoints } from "cloudflare:workers"
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"

export { Tools } from "@/tools"

const viewerSession = z.object({ user: z.object({ id: z.string().min(1) }) }).nullable()

const resolvedApp = z.object({ id: z.uuid() })

const app = new Hono<{ Bindings: Bindings }>()

app.all("*", async (c) => {
	const env = parseEnv(c.env)
	const publicManifest =
		c.req.path === "/slate.json" && ["GET", "HEAD"].includes(c.req.method)
	let session: string | undefined
	if (!publicManifest) {
		const signIn = new URL("/start", env.CTX_VIEWER_AUTH_URL)
		signIn.searchParams.set("return_to", c.req.url)
		session = getCookie(c, "__Secure-ctx_viewer")
		if (!session) return c.redirect(signIn.href)
		const response = await fetch(`${env.CTX_AUTH_ISSUER}/get-session`, {
			headers: { Authorization: `Bearer ${session}` },
		})
		if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`)
		if (!viewerSession.parse(await response.json())) return c.redirect(signIn.href)
	}
	const lookup = new URL("/api/apps/resolve", env.CTX_PLATFORM_URL)
	lookup.searchParams.set("hostname", new URL(c.req.url).hostname)
	const response = await fetch(lookup)
	if (!response.ok) return response
	const { id } = resolvedApp.parse(await response.json())
	const request = new Request(c.req.raw)
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
