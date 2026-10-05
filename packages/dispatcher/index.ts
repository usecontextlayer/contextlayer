import { exports as entrypoints } from "cloudflare:workers"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import {
	appRequestUsage,
	recordAppUsage,
	resolvedAppSchema,
} from "@usecontextlayer/shared/app-usage"
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { type Bindings, parseEnv } from "@/env"

export { Tools } from "@usecontextlayer/shared/tools-worker"

const app = new Hono<{ Bindings: Bindings }>()

app.all("*", async (c) => {
	const env = parseEnv(c.env)
	const session = getCookie(c, "ctx-viewer-auth")
	const headers = new Headers()
	const authorization = c.req.header("authorization")
	if (authorization) headers.set("Authorization", authorization)
	if (session) headers.set("Cookie", `ctx-viewer-auth=${encodeURIComponent(session)}`)
	const lookup = new URL("/api/apps/resolve", env.CTX_PLATFORM_URL)
	const incomingUrl = new URL(c.req.url)
	lookup.searchParams.set("hostname", incomingUrl.hostname)
	lookup.searchParams.set("pathname", incomingUrl.pathname)
	const response = await fetch(lookup, { headers })
	if (response.status === 401) {
		const signIn = new URL("/start", env.CTX_VIEWER_AUTH_URL)
		signIn.searchParams.set("return_to", c.req.url)
		return c.redirect(signIn.href)
	}
	if (!response.ok) return response
	const resolved = resolvedAppSchema.parse(await response.json())
	const { id } = resolved
	const request = new Request(c.req.raw)
	request.headers.delete("authorization")
	const cookies = (request.headers.get("cookie") ?? "")
		.split(";")
		.filter((cookie) => cookie.trim().split("=")[0] !== "ctx-viewer-auth")
		.join(";")
	if (cookies) request.headers.set("cookie", cookies)
	else request.headers.delete("cookie")
	const props = session
		? {
				tools: entrypoints.Tools({
					props: { appId: id, credential: { token: session, type: "session" } },
				}),
			}
		: {}
	const result = await c.env.APPS.get(id, { props }).fetch(request)
	const usage = appRequestUsage(request, result)
	if (usage) {
		const polar = createPolarCore({
			accessToken: env.POLAR_ACCESS_TOKEN,
			environment: env.POLAR_ENVIRONMENT,
		})
		c.executionCtx.waitUntil(recordAppUsage(polar, resolved, usage))
	}
	return result
})

export default app
