import { Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import { type Bindings, parseEnv } from "@/env"

const app = new Hono<{ Bindings: Bindings }>()
const transactionCookie = "__Host-ctx_handoff"
const cookieOptions = {
	httpOnly: true,
	path: "/",
	sameSite: "Lax",
	secure: true,
} as const
const transactionSchema = z.object({
	returnTo: z.url(),
	state: z.uuid(),
})
const sessionSchema = z.object({
	session: z.object({ expiresAt: z.coerce.date(), token: z.string().min(1) }),
})

app.get("/start", async (c) => {
	const env = parseEnv(c.env)
	const returnTo = new URL(z.url().parse(c.req.query("return_to")))
	const labels = returnTo.hostname.split(".")
	if (
		returnTo.protocol !== "https:" ||
		returnTo.port ||
		returnTo.username ||
		returnTo.password ||
		labels.slice(1).join(".") !== env.CTX_APPS_DOMAIN ||
		labels[0] === "auth"
	) {
		return c.text("Invalid app URL", 400)
	}
	const state = crypto.randomUUID()
	setCookie(c, transactionCookie, JSON.stringify({ returnTo: returnTo.href, state }), {
		...cookieOptions,
		maxAge: 600,
	})
	deleteCookie(c, "__Host-ctx_oidc", cookieOptions)
	const destination = new URL("/viewer/sign-in", env.CTX_AUTH_ISSUER)
	destination.searchParams.set("state", state)
	c.header("Cache-Control", "no-store")
	return c.redirect(destination.href)
})

app.get("/callback", async (c) => {
	const env = parseEnv(c.env)
	const transaction = transactionSchema.parse(
		JSON.parse(z.string().parse(getCookie(c, transactionCookie))),
	)
	const query = z
		.object({ state: z.literal(transaction.state), token: z.string().min(1) })
		.parse(c.req.query())
	const response = await fetch(`${env.CTX_AUTH_ISSUER}/one-time-token/verify`, {
		body: JSON.stringify({ token: query.token }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	})
	if (!response.ok) throw new Error(`Session exchange failed: ${response.status}`)
	const { session } = sessionSchema.parse(await response.json())
	deleteCookie(c, transactionCookie, cookieOptions)
	setCookie(c, "__Secure-ctx_viewer", session.token, {
		...cookieOptions,
		domain: env.CTX_APPS_DOMAIN,
		expires: session.expiresAt,
	})
	c.header("Cache-Control", "no-store")
	c.header("Referrer-Policy", "no-referrer")
	return c.redirect(transaction.returnTo)
})

export default app
