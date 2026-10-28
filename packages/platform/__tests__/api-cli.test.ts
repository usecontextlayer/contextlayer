import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { execa } from "execa"
import { test as base, expect } from "vitest"
import { createApi } from "@/api"

const cli = fileURLToPath(new URL("../../cli/dist/cli.mjs", import.meta.url))
type Document = ReturnType<OpenAPIHono["getOpenAPI31Document"]>

const test = base.extend<{
	endpoint: {
		document: Document
		settings: Record<string, string>
		respond?: (response: ServerResponse) => void
		run: (
			...args: string[]
		) => Promise<{ stdout: string; stderr: string; exitCode?: number }>
	}
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Vitest identifies fixture dependencies by destructuring.
	endpoint: async ({}, use) => {
		const directory = await mkdtemp(join(tmpdir(), "ctx-api-"))
		const server = createServer(async (request, response) => {
			response.setHeader("content-type", "application/json")
			if (request.url === "/api/openapi.json") {
				response.end(JSON.stringify(endpoint.document))
			} else if (endpoint.respond) {
				endpoint.respond(response)
			} else {
				const chunks: Buffer[] = []
				for await (const chunk of request) chunks.push(chunk)
				response.end(
					JSON.stringify({
						authorization: request.headers.authorization ?? null,
						body: Buffer.concat(chunks).toString(),
						header: request.headers["x-example"],
						method: request.method,
						url: request.url,
					}),
				)
			}
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("Expected TCP server")
		const settings = {
			CTX_AUTH_CLIENT_ID: "api-cli-test",
			CTX_AUTH_ISSUER: "http://127.0.0.1:1/api/auth",
			CTX_CONFIG_DIR: directory,
			CTX_PLATFORM_URL: `http://127.0.0.1:${address.port}`,
		}
		const schema = new OpenAPIHono()
		schema.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
			scheme: "bearer",
			type: "http",
		})
		schema.openAPIRegistry.registerPath(
			createRoute({
				description: "Accept an opaque value",
				method: "post",
				operationId: "request",
				path: "/values/{key}",
				request: {
					body: { content: { "application/json": { schema: z.unknown() } } },
					headers: z.object({ "X-Example": z.string().optional() }),
					params: z.object({ key: z.string() }),
					query: z.object({ label: z.string().optional() }),
				},
				responses: { 200: { description: "Opaque response" } },
			}),
		)
		const endpoint = {
			document: schema.getOpenAPI31Document({
				info: { title: "CLI contract fixture", version: "1" },
				openapi: "3.1.0",
				security: [{ bearer: [] }],
				servers: [{ url: `${settings.CTX_PLATFORM_URL}/transport` }],
			}),
			respond: undefined as ((response: ServerResponse) => void) | undefined,
			run: (...args: string[]) =>
				execa(process.execPath, [cli, ...args], {
					env: settings,
					reject: false,
					stripFinalNewline: false,
				}),
			settings,
		}
		await writeFile(
			join(directory, "auth.json"),
			JSON.stringify({
				accessToken: "fixture-access-token",
				clientId: settings.CTX_AUTH_CLIENT_ID,
				expiresAt: Date.now() + 60_000,
				issuer: settings.CTX_AUTH_ISSUER,
			}),
		)
		try {
			await use(endpoint)
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
			await rm(directory, { force: true, recursive: true })
		}
	},
})

test("discovers every operation published by the platform without invoking endpoints", async ({
	endpoint,
}) => {
	endpoint.document = await (
		await createApi().request(
			new URL("/openapi.json", endpoint.settings.CTX_PLATFORM_URL).href,
		)
	).json()
	const ids = Object.values(endpoint.document.paths ?? {}).flatMap((path) =>
		Object.values(path ?? {}).flatMap((operation) =>
			typeof operation === "object" && operation && "operationId" in operation
				? [operation.operationId]
				: [],
		),
	)
	const result = await endpoint.run("api", "--help")
	expect(result.exitCode, result.stderr).toBe(0)
	const words = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0])
	expect(ids.length).toBeGreaterThan(0)
	for (const id of ids) expect(words).toContain(id)
})

test("describes the supplied contract without login or invocation", async ({
	endpoint,
}) => {
	await rm(join(String(endpoint.settings.CTX_CONFIG_DIR), "auth.json"))
	endpoint.respond = (response) => {
		response.statusCode = 500
		response.end("Unexpected invocation")
	}
	const described = await endpoint.run("api", "request", "--describe")
	expect(described.exitCode, described.stderr).toBe(0)
	expect(JSON.parse(described.stdout)).toMatchObject({
		description: "Accept an opaque value",
		method: "post",
		operationId: "request",
		path: "/values/{key}",
	})
	const help = await endpoint.run("api", "request", "--help")
	expect(help.exitCode).toBe(0)
	expect(help.stdout).toContain("Accept an opaque value")
})

test("uses the document's server and inputs without changing JSON values", async ({
	endpoint,
}) => {
	for (const value of [
		{ opaque: [true, null, "@file"] },
		[1, "@-"],
		"null",
		false,
		12,
		null,
	]) {
		const result = await endpoint.run(
			"api",
			"request",
			"--params",
			'{"key":"example","label":"literal @- & text","X-Example":"header-value"}',
			"--json",
			JSON.stringify(value),
		)
		expect(result.exitCode, result.stderr).toBe(0)
		const received = JSON.parse(result.stdout).data
		const url = new URL(received.url, endpoint.settings.CTX_PLATFORM_URL)
		expect(received.method).toBe("POST")
		expect(url.pathname).toBe("/transport/values/example")
		expect(url.searchParams.get("label")).toBe("literal @- & text")
		expect(received.header).toBe("header-value")
		expect(JSON.parse(received.body)).toEqual(value)
	}
})

test("preserves HTTP responses and decides failure from HTTP status alone", async ({
	endpoint,
}) => {
	for (const { status, data, exitCode } of [
		{ data: { opaque: ["value", false, null] }, exitCode: 0, status: 200 },
		{ data: false, exitCode: 0, status: 200 },
		{ data: null, exitCode: 0, status: 200 },
		{ data: "", exitCode: 0, status: 204 },
		{ data: { detail: "rejected" }, exitCode: 1, status: 409 },
		{ data: "Unavailable", exitCode: 1, status: 503 },
	]) {
		endpoint.respond = (response) => {
			response.statusCode = status
			response.statusMessage = "Fixture response"
			response.setHeader("x-example", "preserved")
			if (status === 503) response.setHeader("content-type", "text/plain")
			response.end(status === 204 || status === 503 ? data : JSON.stringify(data))
		}
		const result = await endpoint.run("api", "request", "--params", '{"key":"example"}')
		expect(result.exitCode).toBe(exitCode)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toMatchObject({
			data,
			headers: { "x-example": "preserved" },
			status,
			statusText: "Fixture response",
		})
		expect(Object.keys(JSON.parse(result.stdout)).sort()).toEqual([
			"data",
			"headers",
			"status",
			"statusText",
		])
	}
})

test("accepts only inline JSON with an object for parameters", async ({ endpoint }) => {
	for (const args of [
		["--json", "@-"],
		["--json", "@file"],
		["--params", "[]"],
	]) {
		const result = await endpoint.run("api", "request", ...args)
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe("")
		expect(result.stderr).toMatch(/Expected inline JSON|expected record/)
	}
})

test("follows the document's authentication declaration", async ({ endpoint }) => {
	const authenticated = await endpoint.run(
		"api",
		"request",
		"--params",
		'{"key":"example"}',
	)
	expect(JSON.parse(authenticated.stdout).data.authorization).toBe(
		"Bearer fixture-access-token",
	)
	const credentials = join(String(endpoint.settings.CTX_CONFIG_DIR), "auth.json")
	await rm(credentials)
	const required = await endpoint.run("api", "request", "--params", '{"key":"example"}')
	expect(required.exitCode).toBe(1)
	expect(required.stdout).toBe("")
	endpoint.document.security = [{ bearer: [] }, {}]
	const optional = await endpoint.run("api", "request", "--params", '{"key":"example"}')
	expect(JSON.parse(optional.stdout).data.authorization).toBeNull()
	await writeFile(credentials, "invalid JSON")
	const invalid = await endpoint.run("api", "request", "--params", '{"key":"example"}')
	expect(invalid.exitCode).toBe(1)
	expect(invalid.stdout).toBe("")
	endpoint.document.security = [{}]
	const publicCall = await endpoint.run("api", "request", "--params", '{"key":"example"}')
	expect(JSON.parse(publicCall.stdout).data.authorization).toBeNull()
})

test("token output and root help stay independent of API discovery", async ({
	endpoint,
}) => {
	endpoint.settings.CTX_PLATFORM_URL = "http://127.0.0.1:1"
	const token = await endpoint.run("token")
	expect(token.exitCode).toBe(0)
	expect(token.stdout).toBe("fixture-access-token\n")
	const help = await endpoint.run("--help")
	expect(help.exitCode).toBe(0)
	const unavailable = await endpoint.run("api", "--help")
	expect(unavailable.exitCode).toBe(1)
	expect(unavailable.stdout).toBe("")
	expect(unavailable.stderr).not.toBe("")
})
