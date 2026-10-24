import { createMiddleware } from "hono/factory"

export const browserSecurity = createMiddleware(async (c, next) => {
	const site = c.req.header("Sec-Fetch-Site")
	const navigation =
		c.req.method === "GET" &&
		c.req.header("Sec-Fetch-Mode") === "navigate" &&
		c.req.header("Sec-Fetch-Dest") === "document"
	if (!site || site === "same-origin" || site === "none" || navigation) {
		await next()
	} else {
		c.res = c.text("Forbidden", 403)
	}
	c.header("Vary", "Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest", { append: true })
	c.header("Content-Security-Policy", "frame-ancestors 'self'", { append: true })
	const cookies = c.res.headers.getSetCookie()
	c.header("Set-Cookie", undefined)
	for (const cookie of cookies) {
		if (cookie.split("=", 1)[0]?.trim() !== "ctx-viewer-auth") {
			c.header("Set-Cookie", cookie, { append: true })
		}
	}
})
