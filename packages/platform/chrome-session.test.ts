import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { betterAuth } from "better-auth"
import { toNodeHandler } from "better-auth/node"
import { oneTimeToken } from "better-auth/plugins"
import { expect, test } from "vitest"
import { exchangeChromeSession, getChromeIdentity } from "@/chrome-session.server"

test("the partitioned frame cookie reuses a revocable native web session", async () => {
	await using server = createServer()
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`
	const auth = betterAuth({
		baseURL: issuer,
		emailAndPassword: { enabled: true },
		plugins: [oneTimeToken()],
		secret: crypto.randomUUID(),
	})
	server.on("request", toNodeHandler(auth))
	const signedIn = await auth.api.signUpEmail({
		asResponse: true,
		body: {
			email: "frame@example.com",
			name: "Frame viewer",
			password: "test-password-123",
		},
	})
	const nativeCookie = signedIn.headers.getSetCookie()[0]?.split(";")[0]
	assert(nativeCookie)
	const { token } = await auth.api.generateOneTimeToken({
		headers: new Headers({ cookie: nativeCookie }),
	})
	const cookie = await exchangeChromeSession(token, issuer)
	expect(cookie).toContain("__Host-ctx-frame=")
	expect(cookie).toContain("Secure")
	expect(cookie).toContain("HttpOnly")
	expect(cookie).toContain("SameSite=None")
	expect(cookie).toContain("Partitioned")
	expect(cookie).not.toContain("Domain=")
	const frameCookie = cookie.split(";")[0]
	assert(frameCookie)
	const request = new Request(
		"https://slate.usecontextlayer.com/dashboard/chrome/apps/example",
		{ headers: { cookie: frameCookie } },
	)
	const identity = await getChromeIdentity(request, issuer)
	expect(identity?.user.id).toBe(
		(await auth.api.getSession({ headers: new Headers({ cookie: nativeCookie }) }))?.user
			.id,
	)
	await expect(exchangeChromeSession(token, issuer)).rejects.toMatchObject({
		status: 400,
	})
	await auth.api.signOut({ headers: new Headers({ cookie: nativeCookie }) })
	expect(await getChromeIdentity(request, issuer)).toBeNull()
})
