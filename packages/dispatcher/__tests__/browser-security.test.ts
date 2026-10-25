import { Hono } from "hono"
import { expect, test } from "vitest"
import { browserSecurity } from "@/browser-security"

test.each<RequestInit>([
	{ headers: {}, method: "GET" },
	{ headers: { "Sec-Fetch-Site": "none" }, method: "GET" },
	{ headers: { "Sec-Fetch-Site": "same-origin" }, method: "POST" },
	{
		headers: {
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "same-site",
		},
		method: "GET",
	},
	{
		headers: {
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "cross-site",
		},
		method: "GET",
	},
])("allows normal requests and top-level links: %j", async (init) => {
	const app = new Hono().use(browserSecurity).all("*", (c) => c.text("slate"))
	const response = await app.request("https://b.contextlayer.xyz/", init)
	expect(response.status).toBe(200)
	expect(await response.text()).toBe("slate")
	expect(response.headers.get("Content-Security-Policy")).toBe(
		"frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
	)
	expect(response.headers.get("vary")).toBe(
		"Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
	)
})

test.each(["same-site", "cross-site"])(
	"blocks %s background requests, frames and form POSTs before the handler",
	async (site) => {
		const app = new Hono().use(browserSecurity).all("*", () => {
			throw new Error("Blocked request reached authored code")
		})
		for (const [method, mode, destination] of [
			["POST", "cors", "empty"],
			["GET", "no-cors", "image"],
			["GET", "navigate", "iframe"],
			["POST", "navigate", "document"],
		] as const) {
			const response = await app.request("https://b.contextlayer.xyz/", {
				headers: {
					"Sec-Fetch-Dest": destination,
					"Sec-Fetch-Mode": mode,
					"Sec-Fetch-Site": site,
				},
				method,
			})
			expect(response.status).toBe(403)
		}
	},
)

test.each(["/", "/assets/app.js"])(
	"protects viewer cookies and adds browser CSP on authored responses at %s",
	async (path) => {
		const app = new Hono().use(browserSecurity).all("*", () => {
			const headers = new Headers({
				"Content-Security-Policy": "default-src 'self'",
				Vary: "Accept-Encoding",
			})
			for (const cookie of [
				"ctx-viewer-auth=attacker; Domain=contextlayer.xyz; Path=/",
				"ctx-viewer-auth=shadow; Domain=contextlayer.xyz; Path=/api",
				"ctx-viewer-auth=; Max-Age=0; Path=/",
				"theme=dark; Path=/",
				"ctx-viewer-auth-preference=compact; Path=/",
			]) {
				headers.append("Set-Cookie", cookie)
			}
			return new Response("authored response", { headers })
		})
		const response = await app.request(`https://b.contextlayer.xyz${path}`)
		expect(await response.text()).toBe("authored response")
		expect(response.headers.getSetCookie()).toEqual([
			"theme=dark; Path=/",
			"ctx-viewer-auth-preference=compact; Path=/",
		])
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"default-src 'self', frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
		)
		expect(response.headers.get("Vary")).toBe(
			"Accept-Encoding, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
		)
	},
)
