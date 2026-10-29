import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { listAgentJobsRoute } from "@usecontextlayer/shared/agents-api"
import { execa } from "execa"
import { test as base, expect } from "vitest"
import { createApi } from "@/api"

const cliPath = fileURLToPath(new URL("../../cli/dist/cli.mjs", import.meta.url))
type OpenAPIDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>

const test = base.extend<{
	apiCli: {
		document: OpenAPIDocument
		stdin?: string
		settings: Record<string, string>
		respond?: (response: ServerResponse, request: IncomingMessage) => void
		run: (
			...args: string[]
		) => Promise<{ stdout: string; stderr: string; exitCode?: number }>
	}
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Vitest identifies fixture dependencies by destructuring.
	apiCli: async ({}, use) => {
		const directory = await mkdtemp(join(tmpdir(), "ctx-api-"))
		const server = createServer(async (request, response) => {
			response.setHeader("content-type", "application/json")
			if (request.url === "/api/openapi.json") {
				response.end(JSON.stringify(apiCli.document))
			} else if (apiCli.respond) {
				apiCli.respond(response, request)
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
		const api = new OpenAPIHono()
		api.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
			scheme: "bearer",
			type: "http",
		})
		api.openAPIRegistry.registerPath(
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
		const apiCli = {
			document: api.getOpenAPI31Document({
				info: { title: "CLI contract fixture", version: "1" },
				openapi: "3.1.0",
				security: [{ bearer: [] }],
				servers: [{ url: `${settings.CTX_PLATFORM_URL}/transport` }],
			}),
			respond: undefined as
				| ((response: ServerResponse, request: IncomingMessage) => void)
				| undefined,
			run: (...args: string[]) =>
				execa(process.execPath, [cliPath, ...args], {
					env: settings,
					input: apiCli.stdin,
					reject: false,
					stripFinalNewline: false,
				}),
			settings,
			stdin: undefined as string | undefined,
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
			await use(apiCli)
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
			await rm(directory, { force: true, recursive: true })
		}
	},
})

test("discovers every operation published by the platform without invoking endpoints", async ({
	apiCli,
}) => {
	let operationRequests = 0
	apiCli.respond = (response) => {
		operationRequests++
		response.end()
	}
	apiCli.document = await (
		await createApi().request(
			new URL("/openapi.json", apiCli.settings.CTX_PLATFORM_URL).href,
		)
	).json()
	const ids = Object.values(apiCli.document.paths ?? {}).flatMap((path) =>
		Object.values(path ?? {}).flatMap((operation) =>
			typeof operation === "object" && operation && "operationId" in operation
				? [operation.operationId]
				: [],
		),
	)
	const result = await apiCli.run("api", "--help")
	expect(result.exitCode, result.stderr).toBe(0)
	const words = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0])
	expect(ids.length).toBeGreaterThan(0)
	for (const id of ids) expect(words).toContain(id)
	expect(operationRequests).toBe(0)
})

test("describes the supplied contract without login or invocation", async ({
	apiCli,
}) => {
	await rm(join(String(apiCli.settings.CTX_CONFIG_DIR), "auth.json"))
	let operationRequests = 0
	apiCli.respond = (response) => {
		operationRequests++
		response.statusCode = 500
		response.end("Unexpected invocation")
	}
	const describeResult = await apiCli.run("api", "request", "--describe")
	expect(describeResult.exitCode, describeResult.stderr).toBe(0)
	expect(JSON.parse(describeResult.stdout)).toMatchObject({
		openapi: "3.1.0",
		paths: {
			"/values/{key}": {
				post: {
					description: "Accept an opaque value",
					operationId: "request",
				},
			},
		},
		security: [{ bearer: [] }],
		servers: [{ url: `${apiCli.settings.CTX_PLATFORM_URL}/transport` }],
	})
	const helpResult = await apiCli.run("api", "request", "--help")
	expect(helpResult.exitCode).toBe(0)
	expect(helpResult.stdout).toContain("Accept an opaque value")
	expect(operationRequests).toBe(0)
})

test("describes native recursive tool schemas with their OpenAPI references intact", async ({
	apiCli,
}) => {
	await rm(join(String(apiCli.settings.CTX_CONFIG_DIR), "auth.json"))
	let operationRequests = 0
	apiCli.respond = (response) => {
		operationRequests++
		response.statusCode = 500
		response.end("Unexpected invocation")
	}
	apiCli.document = await (
		await createApi().request(
			new URL("/openapi.json", apiCli.settings.CTX_PLATFORM_URL).href,
		)
	).json()
	const result = await apiCli.run("api", "listPersonalAccountSessionTools", "--describe")
	expect(result.exitCode, result.stderr).toBe(0)
	const described = JSON.parse(result.stdout)
	const path = "/accounts/{account_id}/sessions/{session_id}/tools"
	expect(Object.keys(described.paths)).toEqual([path])
	expect(described.paths[path].get.operationId).toBe("listPersonalAccountSessionTools")
	expect(
		described.paths[path].get.responses["200"].content["application/json"].schema,
	).toEqual({ items: { $ref: "#/components/schemas/ComposioTool" }, type: "array" })
	expect(described.components).toEqual(apiCli.document.components)
	expect(described.components.schemas.ComposioTool).toBeDefined()
	expect(operationRequests).toBe(0)
})

test("uses the document's server and inputs without changing JSON values", async ({
	apiCli,
}) => {
	for (const value of [
		{ opaque: [true, null, "@file"] },
		[1, "@-"],
		"null",
		false,
		12,
		null,
	]) {
		const result = await apiCli.run(
			"api",
			"request",
			"--params",
			'{"key":"example","label":"literal @- & text","X-Example":"header-value"}',
			"--json",
			JSON.stringify(value),
		)
		expect(result.exitCode, result.stderr).toBe(0)
		const receivedRequest = JSON.parse(result.stdout).data
		const url = new URL(receivedRequest.url, apiCli.settings.CTX_PLATFORM_URL)
		expect(receivedRequest.method).toBe("POST")
		expect(url.pathname).toBe("/transport/values/example")
		expect(url.searchParams.get("label")).toBe("literal @- & text")
		expect(receivedRequest.header).toBe("header-value")
		expect(JSON.parse(receivedRequest.body)).toEqual(value)
	}
})

test("preserves HTTP responses and decides failure from HTTP status alone", async ({
	apiCli,
}) => {
	for (const { status, data, exitCode } of [
		{ data: { opaque: ["value", false, null] }, exitCode: 0, status: 200 },
		{ data: false, exitCode: 0, status: 200 },
		{ data: null, exitCode: 0, status: 200 },
		{ data: "", exitCode: 0, status: 204 },
		{ data: { detail: "rejected" }, exitCode: 1, status: 409 },
		{ data: "Unavailable", exitCode: 1, status: 503 },
	]) {
		apiCli.respond = (response) => {
			response.statusCode = status
			response.statusMessage = "Fixture response"
			response.setHeader("x-example", "preserved")
			if (status === 503) response.setHeader("content-type", "text/plain")
			response.end(status === 204 || status === 503 ? data : JSON.stringify(data))
		}
		const result = await apiCli.run("api", "request", "--params", '{"key":"example"}')
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

test("accepts only inline JSON with an object for parameters", async ({ apiCli }) => {
	const file = join(String(apiCli.settings.CTX_CONFIG_DIR), "body.json")
	await writeFile(file, '{"source":"file"}')
	apiCli.stdin = '{"source":"stdin"}'
	for (const args of [
		["--params", '{"key":"example"}', "--json", "@-"],
		["--params", '{"key":"example"}', "--json", `@${file}`],
		["--params", "1"],
	]) {
		const result = await apiCli.run("api", "request", ...args)
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe("")
		expect(result.stderr).not.toBe("")
	}
})

test("follows the document's authentication declaration", async ({ apiCli }) => {
	const authenticatedResult = await apiCli.run(
		"api",
		"request",
		"--params",
		'{"key":"example"}',
	)
	expect(JSON.parse(authenticatedResult.stdout).data.authorization).toBe(
		"Bearer fixture-access-token",
	)
	const credentialsPath = join(String(apiCli.settings.CTX_CONFIG_DIR), "auth.json")
	await rm(credentialsPath)
	const missingLoginResult = await apiCli.run(
		"api",
		"request",
		"--params",
		'{"key":"example"}',
	)
	expect(missingLoginResult.exitCode).toBe(1)
	expect(missingLoginResult.stdout).toBe("")
	apiCli.document.security = [{ bearer: [] }, {}]
	const anonymousResult = await apiCli.run(
		"api",
		"request",
		"--params",
		'{"key":"example"}',
	)
	expect(JSON.parse(anonymousResult.stdout).data.authorization).toBeNull()
	await writeFile(credentialsPath, "invalid JSON")
	const invalidLoginResult = await apiCli.run(
		"api",
		"request",
		"--params",
		'{"key":"example"}',
	)
	expect(invalidLoginResult.exitCode).toBe(1)
	expect(invalidLoginResult.stdout).toBe("")
	apiCli.document.security = [{}]
	const publicResult = await apiCli.run("api", "request", "--params", '{"key":"example"}')
	expect(JSON.parse(publicResult.stdout).data.authorization).toBeNull()
})

test("token output and root help stay independent of API discovery", async ({
	apiCli,
}) => {
	apiCli.settings.CTX_PLATFORM_URL = "http://127.0.0.1:1"
	const tokenResult = await apiCli.run("token")
	expect(tokenResult.exitCode).toBe(0)
	expect(tokenResult.stdout).toBe("fixture-access-token\n")
	const helpResult = await apiCli.run("--help")
	expect(helpResult.exitCode).toBe(0)
	const discoveryResult = await apiCli.run("api", "--help")
	expect(discoveryResult.exitCode).toBe(1)
	expect(discoveryResult.stdout).toBe("")
	expect(discoveryResult.stderr).not.toBe("")
})

test("root API target discovers shared agent operations and invokes anonymous loopback without saved credentials", async ({
	apiCli,
}) => {
	const localUrl = String(apiCli.settings.CTX_PLATFORM_URL)
	apiCli.settings.CTX_PLATFORM_URL = "http://127.0.0.1:1"
	await writeFile(
		join(String(apiCli.settings.CTX_CONFIG_DIR), "auth.json"),
		"invalid JSON",
	)
	const jobs = new OpenAPIHono()
	jobs.openapi(listAgentJobsRoute, (c) => c.json({ jobs: [] }, 200))
	const localApi = new OpenAPIHono().route("/slates/:target/agents/:name/jobs", jobs)
	apiCli.document = localApi.getOpenAPI31Document({
		info: { title: "Local agent contract", version: "1" },
		openapi: "3.1.0",
		servers: [{ url: "http://127.0.0.1:1/unselected" }],
	})
	const requests: { url: string | undefined; authorization: string | undefined }[] = []
	apiCli.respond = (response, request) => {
		requests.push({ authorization: request.headers.authorization, url: request.url })
		response.end(JSON.stringify({ jobs: [] }))
	}
	const rootHelp = await apiCli.run("--help")
	expect(rootHelp.exitCode, rootHelp.stderr).toBe(0)
	expect(rootHelp.stdout).toContain("--api-url <url>")
	const help = await apiCli.run("--api-url", localUrl, "api", "--help")
	expect(help.exitCode, help.stderr).toBe(0)
	expect(help.stdout).toContain("listAgentJobs")
	expect(requests).toEqual([])
	const result = await apiCli.run(
		"--api-url",
		localUrl,
		"api",
		"listAgentJobs",
		"--params",
		JSON.stringify({ name: "assistant", target: "local" }),
	)
	expect(result.exitCode, result.stderr).toBe(0)
	expect(JSON.parse(result.stdout)).toMatchObject({ data: { jobs: [] }, status: 200 })
	expect(requests).toEqual([
		{ authorization: undefined, url: "/api/slates/local/agents/assistant/jobs" },
	])
})
