import { test as base } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { expect } from "vitest"
import { appSchema } from "@/apps.schema"

const test = base
	.extend("app", async ({ webSession, platform }, { onCleanup }) => {
		const headers = new Headers(webSession.headers)
		headers.set("origin", platform.origin)
		headers.set("content-type", "application/json")
		const created = await fetch(`${platform.origin}/api/apps`, {
			body: JSON.stringify({}),
			headers,
			method: "POST",
		})
		expect(created.status).toBe(201)
		const app = appSchema.parse(await created.json())
		const { ARTIFACTS } = await platform.worker.getEnv()
		onCleanup(async () => {
			await ARTIFACTS.delete(app.id)
		})
		return app
	})
	.extend("viewerHeaders", ({ app, webEnv, webSession }) =>
		signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${app.public_hostname}/`,
			webHeaders: webSession.headers,
		}),
	)

test("viewer cookies authenticate runtime requests but not management APIs", async ({
	app,
	webSession,
	platform: { origin },
	viewerHeaders,
}) => {
	const resolve = `${origin}/api/apps/resolve?hostname=${app.public_hostname}&pathname=/slate.json`
	expect((await fetch(resolve)).status).toBe(401)
	expect((await fetch(resolve, { headers: viewerHeaders })).status).toBe(200)

	const owner = `user/${webSession.user.id}`
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
			headers: viewerHeaders,
			method,
		})
		expect(response.status, `${method} ${path}`).toBe(401)
	}
})

test("hosted execution is a native capability rather than a public HTTP operation", async ({
	app,
	identity,
	platform: { origin },
	viewerHeaders,
	webSession,
}) => {
	const schema = (await (await fetch(`${origin}/api/openapi.json`)).json()) as {
		paths: Record<string, unknown>
	}
	expect(schema.paths).not.toHaveProperty("/apps/{target}/tools/call")
	expect(schema.paths).not.toHaveProperty("/apps/{target}/databases/query")
	const nativeHeaders = new Headers(webSession.headers)
	nativeHeaders.set("origin", origin)
	for (const [headers, expected] of [
		[viewerHeaders, 401],
		[nativeHeaders, 404],
		[identity.headers, 404],
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

test("native session mutations require the same origin while CLI tokens can join directly", async ({
	app,
	identity,
	platform: { origin },
	webSession,
}) => {
	const join = `${origin}/api/apps/${app.id}/join`
	const nativeHeaders = new Headers(webSession.headers)
	nativeHeaders.delete("origin")
	expect((await fetch(join, { headers: nativeHeaders, method: "POST" })).status).toBe(403)
	nativeHeaders.set("origin", origin)
	for (const headers of [nativeHeaders, identity.headers]) {
		const response = await fetch(join, { headers, method: "POST" })
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ app_id: app.id, user_id: identity.user.id })
	}
})

test("native sessions and CLI tokens can manage apps and accept only scoped resource inputs", async ({
	app,
	identity,
	platform: { origin },
	webSession,
}) => {
	for (const credentials of [webSession.headers, identity.headers]) {
		const headers = new Headers(credentials)
		headers.set("origin", origin)
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

test("personal account execution requires permission to view its app", async ({
	app,
	db,
	identity,
	platform: { origin },
}) => {
	await db
		.updateTable("app")
		.set({ owner_user_id: crypto.randomUUID() })
		.where("id", "=", app.id)
		.execute()
	const headers = new Headers(identity.headers)
	headers.set("content-type", "application/json")
	expect(
		(
			await fetch(`${origin}/api/connections/ca_example/tools/call`, {
				body: JSON.stringify({
					app_id: app.id,
					arguments: {},
					tool: "READ",
					toolkit: "gmail",
				}),
				headers,
				method: "POST",
			})
		).status,
	).toBe(403)
})

test("public app resolution permits declaration paths without a subscription or sign-in", async ({
	app,
	db,
	identity,
	platform: { origin },
}) => {
	await db
		.updateTable("app")
		.set({ visibility: "public" })
		.where("id", "=", app.id)
		.execute()
	const resolve = `${origin}/api/apps/resolve?hostname=${app.public_hostname}&pathname=/slate.json`
	const response = await fetch(resolve)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		id: app.id,
		owner: { id: identity.user.id, type: "user" },
	})
})
