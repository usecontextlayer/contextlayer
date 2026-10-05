import { OpenAPIHono } from "@hono/zod-openapi"
import { createPolarCore } from "@polar-sh/sdk/2026-10"
import { getStateExternalCustomers } from "@polar-sh/sdk/2026-10/services/customers"
import { listEvents } from "@polar-sh/sdk/2026-10/services/events"
import { listMeters } from "@polar-sh/sdk/2026-10/services/meters"
import { provisionEphemeralDatabases } from "@usecontextlayer/db-infra/ephemeral"
import * as usage from "@usecontextlayer/shared/app-usage"
import {
	appRequestUsage,
	recordAppUsage,
	resolvedAppSchema,
} from "@usecontextlayer/shared/app-usage"
import { expect, test, vi } from "vitest"
import { z } from "zod"
import { createApi } from "@/api"
import type { IdentityEnv } from "@/auth.middleware"
import { saveCustomerState } from "@/billing.server"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"
import { toolResultSchema } from "@/tools.schema"
import { callTool } from "@/tools.server"

// Our execution operation is the seam; Polar and Postgres remain real.
vi.mock("@/tools.server", () => ({ callTool: vi.fn() }))

test("personal and organization usage reaches Polar at 1/3/1 clips, without blocking tool responses", async () => {
	const config = z
		.object({
			CTX_TEST_ORGANIZATION_ID: z.string().min(1),
			CTX_TEST_USER_ID: z.string().min(1),
			POLAR_ENVIRONMENT: z.literal("sandbox"),
		})
		.parse(process.env)
	const env = parsePlatformEnv(process.env)
	const polar = createPolarCore({
		accessToken: env.POLAR_ACCESS_TOKEN,
		environment: config.POLAR_ENVIRONMENT,
	})
	const states = await Promise.all(
		[config.CTX_TEST_USER_ID, config.CTX_TEST_ORGANIZATION_ID].map((id) =>
			getStateExternalCustomers(polar)(id),
		),
	)
	const catalog = await listMeters(polar)({ is_archived: false, query: "Clips" })
	const clipsMeter = catalog.items.find((m) => m.name === "Clips")
	if (!clipsMeter) throw new Error("Expected Clips meter")
	const databases = await provisionEphemeralDatabases({
		migrators: { ctx_usage_test: migrateToLatest },
	})
	const db = createPlatformDb(databases.urls.ctx_usage_test)
	const api = new OpenAPIHono<IdentityEnv>()
	api.use("*", async (c, next) => {
		c.set("db", db)
		c.set("config", env)
		c.set("identity", {
			credential: { token: "unused-for-public-apps", type: "access-token" },
			user: { id: config.CTX_TEST_USER_ID },
		})
		await next()
	})
	api.route("/api", createApi())
	const pending: Promise<unknown>[] = []
	const execution = {
		passThroughOnException() {},
		props: {},
		waitUntil: (task: Promise<unknown>) => {
			pending.push(task)
		},
	}
	const result = toolResultSchema.parse({
		data: { value: "executed" },
		error: null,
		logId: "our-execution-result",
	})
	vi.mocked(callTool).mockResolvedValue(result)
	try {
		for (const state of states) {
			expect(state.active_subscriptions.length).toBeGreaterThan(0)
			await saveCustomerState(db, state, null)
			const app = await db
				.insertInto("app")
				.values({
					owner_organization_id: state.type === "team" ? state.external_id : null,
					owner_user_id: state.type === "individual" ? state.external_id : null,
					public_hostname: `${crypto.randomUUID()}.example.com`,
					visibility: "public",
				})
				.returningAll()
				.executeTakeFirstOrThrow()
			const resolvedResponse = await api.request(
				`/api/apps/resolve?${new URLSearchParams({ hostname: app.public_hostname, pathname: "/" })}`,
			)
			expect(resolvedResponse.status).toBe(200)
			const resolved = resolvedAppSchema.parse(await resolvedResponse.json())
			expect(resolved.owner).toEqual({
				id: state.external_id,
				type: state.type === "individual" ? "user" : "organization",
			})
			const meter = state.active_meters.find((m) => m.meter_id === clipsMeter.id)
			if (!meter) throw new Error("Expected subscribed Clips meter")
			for (const method of ["GET", "POST"]) {
				const name = appRequestUsage(
					new Request(`https://${app.public_hostname}/`, { method }),
					new Response(null, { headers: { "content-type": "text/html" } }),
				)
				if (!name) throw new Error("Expected page/action usage")
				expect(await recordAppUsage(polar, resolved, name)).toMatchObject({ inserted: 1 })
			}
			const response = await api.request(
				`/api/apps/${app.id}/tools/call`,
				{
					body: JSON.stringify({ arguments: {}, slug: "mail", tool: "READ" }),
					headers: { "content-type": "application/json" },
					method: "POST",
				},
				undefined,
				execution,
			)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual(result)
			await Promise.all(pending.splice(0))
			await expect
				.poll(
					async () => {
						const events = await listEvents(polar)({
							external_customer_id: resolved.owner.id,
							metadata: { user_code_worker_id: app.id },
						})
						return events.items
							.filter((event) => event.source === "user")
							.map((event) => ({ clips: event.metadata.clips, name: event.name }))
							.sort((a, b) => a.name.localeCompare(b.name))
					},
					{ interval: 1000, timeout: 60_000 },
				)
				.toEqual([
					{ clips: 3, name: "action_call" },
					{ clips: 1, name: "loader_call" },
					{ clips: 1, name: "tool_call" },
				])
			await expect
				.poll(
					async () => {
						const current = await getStateExternalCustomers(polar)(resolved.owner.id)
						return current.active_meters.find((m) => m.meter_id === meter.meter_id)
							?.consumed_units
					},
					{ interval: 1000, timeout: 60_000 },
				)
				.toBe(meter.consumed_units + 5)
			let release!: (value: Awaited<ReturnType<typeof recordAppUsage>>) => void
			const held = new Promise<Awaited<ReturnType<typeof recordAppUsage>>>((resolve) => {
				release = resolve
			})
			const reporter = vi.spyOn(usage, "recordAppUsage").mockReturnValueOnce(held)
			try {
				const nonblocking = await api.request(
					`/api/apps/${app.id}/tools/call`,
					{
						body: JSON.stringify({ arguments: {}, slug: "mail", tool: "READ" }),
						headers: { "content-type": "application/json" },
						method: "POST",
					},
					undefined,
					execution,
				)
				expect(nonblocking.status).toBe(200)
				expect(await nonblocking.json()).toEqual(result)
			} finally {
				release({ duplicates: 0, inserted: 0 })
				reporter.mockRestore()
				await Promise.all(pending.splice(0))
			}
		}
	} finally {
		await Promise.all(pending)
		await db.destroy()
		await databases.dropAll()
	}
}, 180_000)
