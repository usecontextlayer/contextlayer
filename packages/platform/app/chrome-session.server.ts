import { parseSetCookieHeader } from "better-auth/cookies"
import { createCookie } from "react-router"
import { z } from "zod"
import { authenticateSession } from "@/auth.server"

export const chromeSessionCookie = createCookie("__Host-ctx-frame", {
	httpOnly: true,
	partitioned: true,
	path: "/",
	sameSite: "none",
	secure: true,
})

export async function getChromeIdentity(request: Request, issuer: string) {
	const cookie = await chromeSessionCookie.parse(request.headers.get("Cookie"))
	if (!cookie) return null
	const credential = { cookie: z.string().parse(cookie), type: "cookie" } as const
	const user = await authenticateSession(credential, issuer)
	return user ? { credential, user } : null
}

export async function exchangeChromeSession(token: string, issuer: string) {
	const response = await fetch(`${issuer}/one-time-token/verify`, {
		body: JSON.stringify({ token }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	})
	if (!response.ok)
		throw new Response("Session exchange failed", { status: response.status })
	const { session } = z
		.object({ session: z.object({ expiresAt: z.coerce.date() }) })
		.parse(await response.json())
	const cookies = parseSetCookieHeader(response.headers.get("Set-Cookie") ?? "")
	const name = cookies.has("__Secure-better-auth.session_token")
		? "__Secure-better-auth.session_token"
		: "better-auth.session_token"
	const value = z.string().min(1).parse(cookies.get(name)?.value)
	return chromeSessionCookie.serialize(`${name}=${encodeURIComponent(value)}`, {
		expires: session.expiresAt,
	})
}
