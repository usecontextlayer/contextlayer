import * as usage from "@usecontextlayer/shared/app-usage"
import { afterEach, expect, test, vi } from "vitest"
import type { Bindings } from "@/env"
import dispatcher from "@/index"

vi.mock("cloudflare:workers", () => ({ exports: {} }))
vi.mock("@/tools", () => ({ Tools: class {} }))
vi.mock("@/viewer", () => ({ Viewer: class {} }))
vi.mock("@/connections", () => ({ Connections: class {} }))
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

test.each([
	{ method: "GET", path: "/", type: "text/html" },
	{ method: "GET", path: "/index.data", type: "text/x-script" },
	{ method: "POST", path: "/submit", type: "text/html" },
	{ method: "PUT", path: "/api/item", type: "application/json" },
	{ method: "PATCH", path: "/api/item", type: "application/json" },
	{ method: "DELETE", path: "/api/item", type: "application/json" },
	{ method: "GET", path: "/api/report", type: "text/csv" },
	{ method: "GET", path: "/assets/main.js", type: "text/javascript" },
	{ method: "GET", path: "/assets/main.css", type: "text/css" },
	{ method: "GET", path: "/image.png", type: "image/png" },
	{ method: "GET", path: "/slate.json", type: "application/json" },
])(
	"$method $path returns while ingestion is unfinished",
	async ({ method, path, type }) => {
		const app = usage.resolvedAppSchema.parse({
			id: "17b841b6-a89d-4c3c-bce3-ae20bf0cb863",
			owner: { id: "team-owner", type: "organization" },
		})
		vi.stubGlobal("fetch", async () => Response.json(app))
		let release!: (value: Awaited<ReturnType<typeof usage.recordAppUsage>>) => void
		const held = new Promise<Awaited<ReturnType<typeof usage.recordAppUsage>>>(
			(resolve) => {
				release = resolve
			},
		)
		vi.spyOn(usage, "recordAppUsage").mockReturnValue(held)
		const response = new Response("app result", { headers: { "content-type": type } })
		// The authored app and platform resolution are our boundaries. The native Hono handler runs unchanged.
		const env = {
			APPS: { get: () => ({ fetch: async () => response }) },
			CTX_PLATFORM_URL: "https://platform.example.com",
			POLAR_ACCESS_TOKEN: "unused",
			POLAR_ENVIRONMENT: "sandbox",
		} as unknown as Bindings
		const pending: Promise<unknown>[] = []
		const execution = {
			passThroughOnException() {},
			props: {},
			waitUntil: (task: Promise<unknown>) => {
				pending.push(task)
			},
		}
		try {
			const result = await dispatcher.request(
				`https://app.example.com${path}`,
				{ method },
				env,
				execution,
			)
			expect(result.status).toBe(200)
			expect(await result.text()).toBe("app result")
		} finally {
			release({ duplicates: 0, inserted: 0 })
			await Promise.all(pending)
		}
	},
)
