import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import * as usage from "@usecontextlayer/shared/app-usage"
import { mcpManifestSchema } from "@usecontextlayer/shared/mcp"
import { expect, test, vi } from "vitest"
import { z } from "zod"
import { serveMcp } from "@/mcp"

test("discovers a View and invokes an authored tool through native MCP", async () => {
	const manifest = mcpManifestSchema.parse({
		resources: [{ name: "echo", path: "/mcp-ui/echo", uri: "ui://echo/index.html" }],
		tools: [
			{
				_meta: { ui: { resourceUri: "ui://echo/index.html" } },
				inputSchema: z.toJSONSchema(z.object({ value: z.number() })),
				name: "echo",
				outputSchema: z.toJSONSchema(
					z.object({ authorization: z.null(), value: z.unknown() }),
				),
				slate: { connections: {}, secrets: {} },
			},
		],
	})
	// These are our app artifact/execution boundaries. MCP HTTP and validation use the real SDK.
	const namespace = {
		get(_id: string, args?: { props: { mcpTool: string } }) {
			return {
				async fetch(input: Request | URL) {
					const request = new Request(input)
					if (args?.props.mcpTool === "echo") {
						const { value } = await request.json<{ value: number }>()
						const data = { authorization: request.headers.get("authorization"), value }
						return Response.json({
							content: [{ text: String(value), type: "text" }],
							structuredContent: data,
						})
					}
					if (new URL(request.url).pathname === "/mcp.json")
						return Response.json(manifest)
					if (new URL(request.url).pathname === "/mcp-ui/echo")
						return new Response("<html><body>Echo View</body></html>")
					return new Response(null, { status: 404 })
				},
			}
		},
	} as unknown as DispatchNamespace
	const app = usage.resolvedAppSchema.parse({
		id: "17b841b6-a89d-4c3c-bce3-ae20bf0cb863",
		owner: { id: "fixture-owner", type: "user" },
	})
	const env = {
		CTX_PLATFORM_URL: "https://platform.example.com",
		CTX_VIEWER_AUTH_URL: "https://auth.example.com",
		POLAR_ACCESS_TOKEN: "unused",
		POLAR_ENVIRONMENT: "sandbox" as const,
	}
	const pending: Promise<unknown>[] = []
	const ingestion = vi
		.spyOn(usage, "recordAppUsage")
		.mockResolvedValue({ duplicates: 0, inserted: 0 })
	const client = new Client({ name: "dispatcher-protocol-test", version: "1.0.0" })
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL("https://clock.example.com/mcp"), {
				fetch: async (input, init) =>
					serveMcp(new Request(input, init), namespace, app, env, {
						waitUntil: (task) => {
							pending.push(task)
						},
					}),
				requestInit: { headers: { authorization: "Bearer caller-credential" } },
			}),
		)
		const { tools } = await client.listTools()
		expect(tools[0]?.name).toBe("echo")
		expect(tools[0]?._meta?.ui).toEqual({ resourceUri: "ui://echo/index.html" })
		const resource = await client.readResource({ uri: "ui://echo/index.html" })
		expect(resource.contents[0]).toMatchObject({
			mimeType: "text/html;profile=mcp-app",
			text: "<html><body>Echo View</body></html>",
		})
		const result = await client.callTool({ arguments: { value: 42 }, name: "echo" })
		expect(result.structuredContent).toEqual({ authorization: null, value: 42 })
		const invalid = await client.callTool({
			arguments: { value: "not a number" },
			name: "echo",
		})
		expect(invalid.isError).toBe(true)
	} finally {
		await client.close()
		await Promise.all(pending)
		ingestion.mockRestore()
	}
})
