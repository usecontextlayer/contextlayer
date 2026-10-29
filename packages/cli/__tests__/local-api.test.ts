import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { expect, test } from "vitest"
import { z } from "zod"
import { createLocalApi } from "@/local-runtime/api"

test("the local API publishes the common operations anonymously with paths relative to /api", async () => {
	const response = await createLocalApi().request("http://local/openapi.json")
	expect(response.status).toBe(200)
	const document = await response.json()
	expect(document).toMatchObject({
		paths: {
			"/slates/{target}/agents/{name}": { get: { operationId: "getAgent" } },
			"/slates/{target}/agents/{name}/jobs": { post: { operationId: "startAgentJob" } },
		},
		servers: [{ url: "/api" }],
	})
	expect(document).not.toHaveProperty("components.securitySchemes")
	const serialized = JSON.stringify(document)
	const { paths } = z
		.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
		.parse(document)
	const operations = Object.values(paths)
		.flatMap(Object.values)
		.filter((value) => z.object({ operationId: z.string() }).safeParse(value).success)
	expect(operations).toHaveLength(14)
	expect(serialized).not.toContain('"security":')
})

test("ctx dev exposes stack options and validates ports before starting infrastructure", async () => {
	const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url))
	const help = await execa(process.execPath, [cli, "dev", "--help"])
	expect(help.stdout).toContain("--api-port")
	expect(help.stdout).toContain("--port")
	const invalid = await execa(process.execPath, [cli, "dev", "--api-port", "65536"], {
		reject: false,
	})
	expect(invalid.exitCode).toBe(1)
	expect(invalid.stderr).toContain("apiPort")
})
