import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { OpenAPIHono } from "@hono/zod-openapi"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { betterAuth } from "better-auth"
import { toNodeHandler } from "better-auth/node"
import { bearer, jwt } from "better-auth/plugins"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createApi } from "@/api"
import type { IdentityEnv } from "@/auth.middleware"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const server = createServer()
let issuer: string
let viewerCookie: string
let nativeCookie: string
let token: string
let userId: string
let databases: ProvisionedDatabases<"ctx_api_auth_test">
let db: ReturnType<typeof createPlatformDb>

beforeAll(async () => {
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`
	const auth = betterAuth({
		baseURL: issuer,
		emailAndPassword: { enabled: true },
		plugins: [bearer(), jwt()],
		secret: crypto.randomUUID(),
	})
	server.on("request", toNodeHandler(auth))
	const signedIn = await auth.api.signUpEmail({
		body: { email: "viewer@example.com", name: "Viewer", password: "test-password-123" },
		returnHeaders: true,
	})
	userId = signedIn.response.user.id
	const context = await auth.$context
	viewerCookie = `ctx-viewer-auth=${signedIn.response.token}`
	nativeCookie = `${context.authCookies.sessionToken.name}=${signedIn.headers.get("set-auth-token")}`
	const signed = await auth.api.signJWT({
		body: {
			overrideOptions: { jwt: { audience: "urn:ctx:platform", issuer } },
			payload: { scope: "ctx:access", sub: signedIn.response.user.id },
		},
	})
	token = signed.token
	databases = await provisionEphemeralDatabases({
		migrators: { ctx_api_auth_test: migrateToLatest },
	})
	db = createPlatformDb(databases.urls.ctx_api_auth_test)
})

afterAll(async () => {
	await server[Symbol.asyncDispose]()
	await db?.destroy()
	await databases?.dropAll()
})

test("viewer cookies authenticate runtime requests but not management APIs", async () => {
	const config = parsePlatformEnv({
		COMPOSIO_API_KEY: "unused",
		CTX_AUTH_ISSUER: issuer,
		CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_api_auth_test,
		POLAR_ACCESS_TOKEN: "unused",
		POLAR_ENVIRONMENT: "sandbox",
		POLAR_WEBHOOK_SECRET: "unused",
	})
	const app = await db
		.insertInto("app")
		.values({
			owner_user_id: userId,
			public_hostname: "viewer.contextlayer.xyz",
			visibility: "private",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	const api = new OpenAPIHono<IdentityEnv>()
	api.use("*", async (c, next) => {
		c.set("config", config)
		c.set("db", db)
		await next()
	})
	api.route("/api", createApi())
	const resolve = `/api/apps/resolve?hostname=${app.public_hostname}&pathname=/slate.json`
	expect((await api.request(resolve)).status).toBe(401)
	expect((await api.request(resolve, { headers: { cookie: viewerCookie } })).status).toBe(
		200,
	)
	// The runtime token passes identity and private viewing before the subscription gate.
	expect(
		(
			await api.request(`/api/apps/${app.id}/tools/call`, {
				headers: { cookie: viewerCookie },
				method: "POST",
			})
		).status,
	).toBe(402)

	const owner = `user/${userId}`
	for (const [method, path] of [
		["GET", "/apps"],
		["POST", "/apps"],
		["PATCH", `/apps/${app.id}`],
		["GET", `/apps/${app.id}/agents/example`],
		["GET", `/connections/${owner}`],
		["POST", `/connections/${owner}`],
		["GET", "/connections?toolkit=gmail"],
		["POST", "/connections/ca_example/tools/call"],
		["POST", `/apps/${app.id}/resources/list`],
		["POST", `/apps/${app.id}/connections/list`],
		["POST", `/apps/${app.id}/connections/assign`],
		["PUT", `/secrets/${owner}/example`],
		["DELETE", `/secrets/${owner}/example`],
	]) {
		const response = await api.request(`/api${path}`, {
			headers: { cookie: viewerCookie },
			method,
		})
		expect(response.status, `${method} ${path}`).toBe(401)
	}

	for (const headers of [
		new Headers({ cookie: nativeCookie }),
		new Headers({ authorization: `Bearer ${token}` }),
	]) {
		headers.set("content-type", "application/json")
		const response = await api.request(`/api/apps/${app.id}`, {
			body: JSON.stringify({ visibility: "private" }),
			headers,
			method: "PATCH",
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ id: app.id, visibility: "private" })
		expect((await api.request("/api/connections", { headers })).status).toBe(400)
		expect(
			(await api.request("/api/connections?toolkit=gmail&owner_id=other", { headers }))
				.status,
		).toBe(400)
		const concreteCall = {
			app_id: app.id,
			arguments: {},
			tool: "READ",
			toolkit: "gmail",
		}
		const callConnection = (body: unknown) =>
			api.request("/api/connections/ca_example/tools/call", {
				body: JSON.stringify(body),
				headers,
				method: "POST",
			})
		expect((await callConnection(concreteCall)).status).toBe(402)
		expect(
			(await callConnection({ ...concreteCall, resources: { connections: {} } })).status,
		).toBe(400)
		expect(
			(await callConnection({ ...concreteCall, app_id: crypto.randomUUID() })).status,
		).toBe(404)
		for (const [path, body] of [
			["resources/list", {}],
			["connections/list", {}],
			["connections/assign", { connection_id: "ca_example", slug: "mail" }],
		] as const) {
			expect(
				(
					await api.request(`/api/apps/${app.id}/${path}`, {
						body: JSON.stringify({ ...body, resources: { connections: {} } }),
						headers,
						method: "POST",
					})
				).status,
			).toBe(400)
		}
	}
	const forbiddenApp = await db
		.insertInto("app")
		.values({
			owner_user_id: "another-user",
			public_hostname: "another.contextlayer.xyz",
			visibility: "private",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	expect(
		(
			await api.request("/api/connections/ca_example/tools/call", {
				body: JSON.stringify({
					app_id: forbiddenApp.id,
					arguments: {},
					tool: "READ",
					toolkit: "gmail",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			})
		).status,
	).toBe(403)
	await db
		.updateTable("app")
		.set({ visibility: "public" })
		.where("id", "=", app.id)
		.execute()
	expect((await api.request(resolve)).status).toBe(200)
})
