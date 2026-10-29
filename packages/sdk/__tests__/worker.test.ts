import { expect, test } from "vitest"
import { z } from "zod"
import { createSlateWorker, type McpToolModule, type SlateWorker } from "@/worker"

const inputSchema = z.object({ count: z.coerce.number().int() })
const module: McpToolModule = {
	handler({ count }: z.infer<typeof inputSchema>) {
		return {
			_meta: { source: "authored-handler" },
			content: [{ text: `Count: ${count}`, type: "text" }],
			isError: false,
			structuredContent: { count },
		}
	},
	tool: { inputSchema, name: "count_items" },
}
const worker = createSlateWorker({
	development: false,
	mcp: { "./mcp/count/index.ts": module },
	mode: "production",
})
const bindings = {
	databases: {
		async query() {
			throw new Error("No database call is expected")
		},
	},
	tools: {
		async call() {
			throw new Error("No tool call is expected")
		},
	},
}
const env = { DATABASES: bindings.databases, TOOLS: bindings.tools }

function context(mcpTool?: string) {
	return { props: { ...bindings, mcpTool } } as unknown as Parameters<
		SlateWorker["fetch"]
	>[2]
}

function request(url: string, init?: RequestInit) {
	return new Request(url, init) as Parameters<SlateWorker["fetch"]>[0]
}

test("an app-independent worker returns the native MCP result after input validation", async () => {
	const response = await worker.fetch(
		request("https://slate.example.com/", {
			body: JSON.stringify({ count: "3" }),
			method: "POST",
		}),
		env,
		context("count_items"),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		_meta: { source: "authored-handler" },
		content: [{ text: "Count: 3", type: "text" }],
		isError: false,
		structuredContent: { count: 3 },
	})
})

test("MCP tool inputs must satisfy the authored Zod schema", async () => {
	await expect(
		worker.fetch(
			request("https://slate.example.com/", {
				body: JSON.stringify({ count: "three" }),
				method: "POST",
			}),
			env,
			context("count_items"),
		),
	).rejects.toBeInstanceOf(z.ZodError)
})

test("trusted dispatch rejects an unknown MCP tool name", async () => {
	await expect(
		worker.fetch(request("https://slate.example.com/"), env, context("missing")),
	).rejects.toThrow("Unknown MCP tool: missing")
})

test.each(["/", "/mcp/count_items?mcpTool=count_items"])(
	"ordinary HTTP requests to %s return not found when there is no app",
	async (pathname) => {
		const response = await worker.fetch(
			request(`https://slate.example.com${pathname}`, {
				body: JSON.stringify({ count: 3 }),
				headers: { "x-mcp-tool": "count_items" },
				method: "POST",
			}),
			env,
			context(),
		)

		expect(response.status).toBe(404)
		expect(await response.text()).toBe("")
	},
)
