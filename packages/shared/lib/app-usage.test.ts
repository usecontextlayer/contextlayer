import { expect, test } from "vitest"
import { appRequestUsage } from "@/lib/app-usage"

const request = (path: string, method = "GET") =>
	new Request(`https://app.example.com${path}`, { method })
const response = (contentType: string) =>
	new Response(null, { headers: { "content-type": contentType } })

test.each([
	"text/html; charset=utf-8",
	"application/json",
	"text/x-script",
	"text/plain",
	"text/csv",
	"text/xml",
	"application/xml",
	"application/x-ndjson",
	"application/ndjson",
	"text/event-stream",
	"application/problem+json",
])("dynamic GETs count one loader event: %s", (type) => {
	expect(appRequestUsage(request("/api/data"), response(type))).toBe("loader_call")
})

test.each(["POST", "PUT", "PATCH", "DELETE"])(
	"%s counts one action event for recognised dynamic responses",
	(method) => {
		expect(
			appRequestUsage(request("/api/data", method), response("application/json")),
		).toBe("action_call")
	},
)

test.each([
	"text/javascript",
	"application/javascript",
	"text/css",
	"image/png",
	"image/svg+xml",
	"font/woff2",
	"application/wasm",
])("assets generate no usage for reads or mutations: %s", (type) => {
	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
		expect(appRequestUsage(request("/asset", method), response(type))).toBeNull()
	}
})

test("the manifest is free for reads and mutations even though it returns JSON", () => {
	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
		expect(
			appRequestUsage(request("/slate.json", method), response("application/json")),
		).toBeNull()
	}
})

test.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
	"%s redirects retain their request charge",
	(method) => {
		expect(
			appRequestUsage(
				request("/submit", method),
				Response.redirect("https://app.example.com/done", 303),
			),
		).toBe(method === "GET" ? "loader_call" : "action_call")
	},
)
