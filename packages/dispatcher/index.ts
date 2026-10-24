import { exports as entrypoints } from "cloudflare:workers"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import {
	recordSlateUsage,
	resolvedSlateSchema,
	slateRequestUsage,
} from "@usecontextlayer/shared/slate-usage"
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { browserSecurity } from "@/browser-security"
import { type Bindings, parseEnv } from "@/env"
import { serveMcp } from "@/mcp"

export { Databases } from "@usecontextlayer/shared/databases-worker"
export { Tools } from "@usecontextlayer/shared/tools-worker"

const app = new Hono<{ Bindings: Bindings }>()

app.get("/.well-known/oauth-protected-resource/mcp", async (c) => {
	const env = parseEnv(c.env)
	const lookup = new URL("/api/slates/mcp/metadata", env.CTX_PLATFORM_URL)
	lookup.searchParams.set("hostname", new URL(c.req.url).hostname)
	return fetch(lookup)
})

app.all("/mcp", async (c) => {
	const env = parseEnv(c.env)
	const incomingUrl = new URL(c.req.url)
	const lookup = new URL("/api/slates/resolve", env.CTX_PLATFORM_URL)
	lookup.searchParams.set("hostname", incomingUrl.hostname)
	lookup.searchParams.set("pathname", incomingUrl.pathname)
	const headers = new Headers()
	const authorization = c.req.header("authorization")
	if (authorization) headers.set("Authorization", authorization)
	const response = await fetch(lookup, { headers })
	if (!response.ok) return response
	const resolved = resolvedSlateSchema.parse(await response.json())
	return serveMcp(c.req.raw, c.env.SLATES, resolved, env, c.executionCtx)
})

app.use("*", browserSecurity)

app.all("*", async (c) => {
	const env = parseEnv(c.env)
	const session = getCookie(c, "ctx-viewer-auth")
	const headers = new Headers()
	const authorization = c.req.header("authorization")
	if (authorization) headers.set("Authorization", authorization)
	if (session) headers.set("Cookie", `ctx-viewer-auth=${encodeURIComponent(session)}`)
	const lookup = new URL("/api/slates/resolve", env.CTX_PLATFORM_URL)
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
	const resolved = resolvedSlateSchema.parse(await response.json())
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
				databases: entrypoints.Databases({
					props: { credential: { token: session, type: "session" }, slateId: id },
				}),
				tools: entrypoints.Tools({
					props: { credential: { token: session, type: "session" }, slateId: id },
				}),
			}
		: {}
	const result = await c.env.SLATES.get(id, { props }).fetch(request)
	const usage = slateRequestUsage(request, result)
	if (usage) {
		const polar = createPolarCore({
			accessToken: env.POLAR_ACCESS_TOKEN,
			environment: env.POLAR_ENVIRONMENT,
		})
		c.executionCtx.waitUntil(recordSlateUsage(polar, resolved, usage))
	}
	return result
})

export default app
