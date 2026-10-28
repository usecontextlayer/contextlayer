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
		["GET", `/slates/${slate.id}/cloudflare`],
		["GET", `/accounts/${owner}`],
		["POST", `/accounts/${owner}`],
		["GET", "/accounts?toolkit=gmail"],
		["POST", "/accounts/ca_example/tools/call"],
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

test("dashboard denies framing and chrome permits only its canonical slate", async ({
	slate,
	webSession,
	platform: { origin },
}) => {
	const dashboard = await fetch(`${origin}/dashboard/personal/slates`, {
		headers: webSession.headers,
	})
	expect(dashboard.status).toBe(200)
	expect(dashboard.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
	const chrome = new URL(`/dashboard/chrome/slates/${slate.id}`, origin)
	chrome.searchParams.set("parentOrigin", "https://another-slate.contextlayer.xyz")
	for (const headers of [undefined, webSession.headers]) {
		const response = await fetch(chrome, { headers })
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(response.headers.get("content-security-policy")).toBe(
			`frame-ancestors https://${slate.public_hostname}; base-uri 'none'; object-src 'none'; form-action 'self' https://connect.composio.dev https://dashboard.composio.dev`,
		)
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

test("native forms enforce CSRF while sessions and CLI tokens can update JSON directly", async ({
	slate,
	identity,
	platform: { origin },
	webSession,
}) => {
	const update = `${origin}/api/slates/${slate.id}`
	const chrome = new URL(`/dashboard/chrome/slates/${slate.id}`, origin)
	chrome.searchParams.set("parentOrigin", `https://${slate.public_hostname}`)
	const nativeHeaders = new Headers(webSession.headers)
	nativeHeaders.delete("origin")
	const form = new URLSearchParams({
		account_id: "ca_example",
		intent: "assign",
		slug: "mail",
	})
	expect(
		(
			await fetch(chrome, {
				body: form,
				headers: nativeHeaders,
				method: "POST",
			})
		).status,
	).toBe(403)
	nativeHeaders.set("origin", origin)
	const unpushed = await fetch(chrome, {
		body: form,
		headers: nativeHeaders,
		method: "POST",
	})
	expect(unpushed.status).toBe(409)
	nativeHeaders.delete("origin")
	for (const headers of [nativeHeaders, identity.headers]) {
		const response = await fetch(update, {
			body: JSON.stringify({ visibility: "private" }),
			headers: {
				...Object.fromEntries(new Headers(headers)),
				"content-type": "application/json",
			},
			method: "PATCH",
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ id: slate.id, visibility: "private" })
	}
})

test("native sessions and CLI tokens can manage slates and accept only scoped resource inputs", async ({
	slate,
	db,
	identity,
	platform: { origin },
	webSession,
}) => {
	const slateWithoutPolarCustomer = await db
		.insertInto("slate")
		.values({
			owner_user_id: crypto.randomUUID(),
			public_hostname: "missing-customer.example.com",
			visibility: "public",
		})
		.returningAll()
		.executeTakeFirstOrThrow()
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
		expect((await fetch(`${origin}/api/accounts`, { headers })).status).toBe(400)
		expect(
			(await fetch(`${origin}/api/accounts?toolkit=gmail&owner_id=other`, { headers }))
				.status,
		).toBe(400)
		const concreteCall = {
			arguments: {},
			slate_id: slateWithoutPolarCustomer.id,
			tool: "READ",
			toolkit: "gmail",
		}
		const callAccount = (body: unknown) =>
			fetch(`${origin}/api/accounts/ca_example/tools/call`, {
				body: JSON.stringify(body),
				headers,
				method: "POST",
			})
		expect((await callAccount(concreteCall)).status).toBe(403)
		expect(
			(await callAccount({ ...concreteCall, resources: { connections: {} } })).status,
		).toBe(400)
		expect(
			(await callAccount({ ...concreteCall, slate_id: crypto.randomUUID() })).status,
		).toBe(404)
		for (const [path, body] of [
			["resources/list", {}],
			["connections/list", {}],
			["connections/assign", { account_id: "ca_example", slug: "mail" }],
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

test("personal connected account execution requires permission to manage personal and organization slates", async ({
	db,
	identity,
	platform: { origin },
}) => {
	const headers = new Headers(identity.headers)
	headers.set("content-type", "application/json")
	for (const owner of [
		{ owner_organization_id: null, owner_user_id: crypto.randomUUID() },
		{ owner_organization_id: crypto.randomUUID(), owner_user_id: null },
	]) {
		const slate = await db
			.insertInto("slate")
			.values({
				...owner,
				public_hostname: `${crypto.randomUUID()}.example.com`,
				visibility: "public",
			})
			.returning("id")
			.executeTakeFirstOrThrow()
		expect(
			(
				await fetch(`${origin}/api/accounts/ca_example/tools/call`, {
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
	}
})

test("declaration resolution enforces private visibility and permits public access", async ({
	slate,
	db,
	identity,
	platform: { origin },
}) => {
	const resolve = `${origin}/api/slates/resolve?hostname=${slate.public_hostname}&pathname=/slate.json`
	expect((await fetch(resolve)).status).toBe(401)
	expect((await fetch(resolve, { headers: identity.headers })).status).toBe(200)
	await db
		.updateTable("slate")
		.set({ visibility: "public" })
		.where("id", "=", slate.id)
		.execute()
	const response = await fetch(resolve)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		id: slate.id,
		owner: { id: identity.user.id, type: "personal" },
	})
})
