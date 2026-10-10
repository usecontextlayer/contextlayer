import { test as base } from "@tests/integration"
import { signInViewer } from "@usecontextlayer/dev-env/viewer"
import { expect } from "vitest"
import { slateSchema } from "@/slates.schema"

const test = base
	.extend("slate", async ({ webSession, platform }, { onCleanup }) => {
		const headers = new Headers(webSession.headers)
		headers.set("origin", platform.origin)
		headers.set("content-type", "application/json")
		const created = await fetch(`${platform.origin}/api/slates`, {
			body: JSON.stringify({}),
			headers,
			method: "POST",
		})
		expect(created.status).toBe(201)
		const slate = slateSchema.parse(await created.json())
		const { ARTIFACTS } = await platform.worker.getEnv()
		onCleanup(async () => {
			await ARTIFACTS.delete(slate.id)
		})
		return slate
	})
	.extend("viewerHeaders", ({ slate, webEnv, webSession }) =>
		signInViewer({
			authURL: webEnv.CTX_VIEWER_AUTH_URL,
			returnTo: `https://${slate.public_hostname}/`,
			webHeaders: webSession.headers,
		}),
	)

test("viewer cookies authenticate runtime requests but not management APIs", async ({
	slate,
	webSession,
	platform: { origin },
	viewerHeaders,
}) => {
	const resolve = `${origin}/api/slates/resolve?hostname=${slate.public_hostname}&pathname=/slate.json`
	expect((await fetch(resolve)).status).toBe(401)
	expect((await fetch(resolve, { headers: viewerHeaders })).status).toBe(200)

	const owner = `personal/${webSession.user.id}`
	for (const [method, path] of [
		["GET", "/slates"],
		["POST", "/slates"],
		["PATCH", `/slates/${slate.id}`],
		["GET", `/slates/${slate.id}/agents/example`],
		["GET", `/connections/${owner}`],
		["POST", `/connections/${owner}`],
		["GET", "/connections?toolkit=gmail"],
		["POST", "/connections/ca_example/tools/call"],
		["POST", `/slates/${slate.id}/resources/list`],
		["POST", `/slates/${slate.id}/connections/list`],
		["POST", `/slates/${slate.id}/connections/assign`],
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
	slate,
	identity,
	platform: { origin },
	viewerHeaders,
	webSession,
}) => {
	const schema = (await (await fetch(`${origin}/api/openapi.json`)).json()) as {
		paths: Record<string, unknown>
	}
	expect(schema.paths).not.toHaveProperty("/slates/{target}/tools/call")
	expect(schema.paths).not.toHaveProperty("/slates/{target}/databases/query")
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
					await fetch(`${origin}/api/slates/${slate.id}/${operation}`, {
						headers,
						method: "POST",
					})
				).status,
			).toBe(expected)
		}
	}
})

test("native session mutations require the same origin while CLI tokens can join directly", async ({
	slate,
	identity,
	platform: { origin },
	webSession,
}) => {
	const join = `${origin}/api/slates/${slate.id}/join`
	const nativeHeaders = new Headers(webSession.headers)
	nativeHeaders.delete("origin")
	expect((await fetch(join, { headers: nativeHeaders, method: "POST" })).status).toBe(403)
	nativeHeaders.set("origin", origin)
	for (const headers of [nativeHeaders, identity.headers]) {
		const response = await fetch(join, { headers, method: "POST" })
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			slate_id: slate.id,
			user_id: identity.user.id,
		})
	}
})

test("native sessions and CLI tokens can manage slates and accept only scoped resource inputs", async ({
	slate,
	identity,
	platform: { origin },
	webSession,
}) => {
	for (const credentials of [webSession.headers, identity.headers]) {
		const headers = new Headers(credentials)
		headers.set("origin", origin)
		headers.set("content-type", "application/json")
		const response = await fetch(`${origin}/api/slates/${slate.id}`, {
			body: JSON.stringify({ visibility: "private" }),
			headers,
			method: "PATCH",
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ id: slate.id, visibility: "private" })
		expect((await fetch(`${origin}/api/connections`, { headers })).status).toBe(400)
		expect(
			(await fetch(`${origin}/api/connections?toolkit=gmail&owner_id=other`, { headers }))
				.status,
		).toBe(400)
		const concreteCall = {
			arguments: {},
			slate_id: slate.id,
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
			(await callConnection({ ...concreteCall, slate_id: crypto.randomUUID() })).status,
		).toBe(404)
		for (const [path, body] of [
			["resources/list", {}],
			["connections/list", {}],
			["connections/assign", { connection_id: "ca_example", slug: "mail" }],
		] as const) {
			expect(
				(
					await fetch(`${origin}/api/slates/${slate.id}/${path}`, {
						body: JSON.stringify({ ...body, resources: { connections: {} } }),
						headers,
						method: "POST",
					})
				).status,
			).toBe(400)
		}
	}
})

test("personal connected account execution requires permission to view its slate", async ({
	slate,
	db,
	identity,
	platform: { origin },
}) => {
	await db
		.updateTable("slate")
		.set({ owner_user_id: crypto.randomUUID() })
		.where("id", "=", slate.id)
		.execute()
	const headers = new Headers(identity.headers)
	headers.set("content-type", "application/json")
	expect(
		(
			await fetch(`${origin}/api/connections/ca_example/tools/call`, {
				body: JSON.stringify({
					arguments: {},
					slate_id: slate.id,
					tool: "READ",
					toolkit: "gmail",
				}),
				headers,
				method: "POST",
			})
		).status,
	).toBe(403)
})

test("public slate resolution permits declaration paths without a subscription or sign-in", async ({
	slate,
	db,
	identity,
	platform: { origin },
}) => {
	await db
		.updateTable("slate")
		.set({ visibility: "public" })
		.where("id", "=", slate.id)
		.execute()
	const resolve = `${origin}/api/slates/resolve?hostname=${slate.public_hostname}&pathname=/slate.json`
	const response = await fetch(resolve)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		id: slate.id,
		owner: { id: identity.user.id, type: "personal" },
	})
})
