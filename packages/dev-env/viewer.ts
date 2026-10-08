import assert from "node:assert/strict"
import { applySetCookies } from "better-auth/cookies"
import { z } from "zod"

export async function signInViewer({
	authURL,
	returnTo,
	webHeaders,
}: {
	authURL: string
	returnTo: string
	webHeaders: Headers
}) {
	const startURL = new URL("/start", authURL)
	startURL.searchParams.set("return_to", returnTo)
	const start = await fetch(startURL, { redirect: "manual" })
	assert.equal(start.status, 302, "Viewer handoff did not start")
	const transactionHeaders = new Headers()
	applySetCookies(transactionHeaders, start.headers.getSetCookie())

	const signIn = await fetch(z.url().parse(start.headers.get("location")), {
		headers: webHeaders,
		redirect: "manual",
	})
	assert.equal(signIn.status, 307, "Web did not redirect viewer sign-in")
	const callback = await fetch(z.url().parse(signIn.headers.get("location")), {
		headers: transactionHeaders,
		redirect: "manual",
	})
	assert.equal(callback.status, 302, "Viewer handoff did not finish")
	const headers = new Headers()
	applySetCookies(headers, callback.headers.getSetCookie())
	return headers
}
