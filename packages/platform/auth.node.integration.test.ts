import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
	type ProvisionedDatabases,
	provisionEphemeralDatabases,
} from "@usecontextlayer/db-infra/ephemeral"
import { betterAuth } from "better-auth"
import { toNodeHandler } from "better-auth/node"
import { bearer, jwt } from "better-auth/plugins"
import { afterAll, beforeAll, expect, test } from "vitest"
import { createTestHarness } from "wrangler"
import { z } from "zod"
import { createPlatformDb } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { parsePlatformEnv } from "@/env"

const server = createServer()
const worker = createTestHarness()
let origin: string
let issuer: string
let viewerCookie: string
let nativeCookie: string
let token: string
let userId: string
let databases: ProvisionedDatabases<"ctx_api_auth_test">
let db: ReturnType<typeof createPlatformDb>
let app: Awaited<ReturnType<typeof createApp>>
let forbiddenApp: Awaited<ReturnType<typeof createApp>>

function createApp(
	ownerId: string,
	hostname: string,
	visibility: "private" | "public" = "private",
) {
	return db
		.insertInto("app")
		.values({
			owner_user_id: ownerId,
			public_hostname: hostname,
			visibility,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
}

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
	app = await createApp(userId, "viewer.contextlayer.xyz")
	const anotherUser = await auth.api.signUpEmail({
		body: {
			email: "another@example.com",
			name: "Another viewer",
			password: "test-password-123",
		},
	})
	forbiddenApp = await createApp(anotherUser.user.id, "another.contextlayer.xyz")
	await worker.update({
		workers: [
			{
				configPath: new URL("./wrangler.jsonc", import.meta.url),
				env: "test",
				prebuiltWorkerDir: new URL("./build/server", import.meta.url),
				secrets: parsePlatformEnv({
					COMPOSIO_API_KEY: "unused",
					CTX_AUTH_ISSUER: issuer,
					CTX_CUSTOMER_CREDENTIALS_DOPPLER_CONFIG: "unused",
					CTX_CUSTOMER_CREDENTIALS_DOPPLER_PROJECT: "unused",
					CTX_CUSTOMER_CREDENTIALS_DOPPLER_TOKEN: "unused",
					CTX_PLATFORM_DATABASE_URL: databases.urls.ctx_api_auth_test,
					POLAR_ACCESS_TOKEN: "unused",
					POLAR_ENVIRONMENT: "sandbox",
					POLAR_WEBHOOK_SECRET: "unused",
				}),
			},
		],
	})
	origin = (await worker.listen()).url.origin
})

afterAll(async () => {
	await worker.close()
	await server[Symbol.asyncDispose]()
	await db?.destroy()
	await databases?.dropAll()
})

test("viewer cookies authenticate app resolution but not management APIs", async () => {
	const resolve = `${origin}/api/apps/resolve?hostname=${app.public_hostname}&pathname=/slate.json`
	expect((await fetch(resolve)).status).toBe(401)
	expect((await fetch(resolve, { headers: { cookie: viewerCookie } })).status).toBe(200)
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
		const response = await fetch(`${origin}/api${path}`, {
			headers: { cookie: viewerCookie },
			method,
		})
		expect(response.status, `${method} ${path}`).toBe(401)
	}
})

test("hosted execution routes are absent from OpenAPI and reject HTTP calls", async () => {
	const schema = z
		.object({ paths: z.record(z.string(), z.unknown()) })
		.parse(await (await fetch(`${origin}/api/openapi.json`)).json())
	expect(schema.paths).not.toHaveProperty("/apps/{target}/tools/call")
	expect(schema.paths).not.toHaveProperty("/apps/{target}/databases/query")
	for (const [headers, expected] of [
		[new Headers({ cookie: viewerCookie, origin }), 401],
		[new Headers({ cookie: nativeCookie, origin }), 404],
		[new Headers({ authorization: `Bearer ${token}` }), 404],
	] as const) {
		for (const operation of ["tools/call", "databases/query"]) {
			expect(
				(
					await fetch(`${origin}/api/apps/${app.id}/${operation}`, {
						headers,
						method: "POST",
					})
				).status,
			).toBe(expected)
		}
	}
})

test("native session mutations require the same origin while CLI tokens can join directly", async () => {
	const join = `${origin}/api/apps/${app.id}/join`
	expect(
		(await fetch(join, { headers: { cookie: nativeCookie }, method: "POST" })).status,
	).toBe(403)
	for (const headers of [
		new Headers({ cookie: nativeCookie, origin }),
		new Headers({ authorization: `Bearer ${token}` }),
	]) {
		const response = await fetch(join, { headers, method: "POST" })
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ app_id: app.id, user_id: userId })
	}
})

test("native sessions and CLI tokens can manage apps and accept only scoped resource inputs", async () => {
	for (const headers of [
		new Headers({ cookie: nativeCookie }),
		new Headers({ authorization: `Bearer ${token}` }),
	]) {
		headers.set("content-type", "application/json")
		const response = await fetch(`${origin}/api/apps/${app.id}`, {
			body: JSON.stringify({ visibility: "private" }),
			headers,
			method: "PATCH",
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ id: app.id, visibility: "private" })
		expect((await fetch(`${origin}/api/connections`, { headers })).status).toBe(400)
		expect(
			(await fetch(`${origin}/api/connections?toolkit=gmail&owner_id=other`, { headers }))
				.status,
		).toBe(400)
		const concreteCall = {
			app_id: app.id,
			arguments: {},
			tool: "READ",
			toolkit: "gmail",
		}
		const callConnection = (body: unknown) =>
			fetch(`${origin}/api/connections/ca_example/tools/call`, {
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
					await fetch(`${origin}/api/apps/${app.id}/${path}`, {
						body: JSON.stringify({ ...body, resources: { connections: {} } }),
						headers,
						method: "POST",
					})
				).status,
			).toBe(400)
		}
	}
})

test("personal account execution requires permission to view its app", async () => {
	expect(
		(
			await fetch(`${origin}/api/connections/ca_example/tools/call`, {
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
})

test("public app resolution permits declaration paths without a subscription or sign-in", async () => {
	const publicApp = await createApp(userId, "public.contextlayer.xyz", "public")
	const resolve = `${origin}/api/apps/resolve?hostname=${publicApp.public_hostname}&pathname=/slate.json`
	const response = await fetch(resolve)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		id: publicApp.id,
		owner: { id: userId, type: "user" },
	})
})
