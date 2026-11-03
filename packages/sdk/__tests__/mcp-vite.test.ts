import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createBuilder } from "vite"
import { expect, test } from "vitest"
import { mcpApps } from "@/mcp-vite"

async function createProject(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "sdk-mcp-build-"))
	await symlink(
		resolve(import.meta.dirname, "../node_modules"),
		join(root, "node_modules"),
	)
	for (const [file, source] of Object.entries(files)) {
		const path = join(root, file)
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, source)
	}
	return {
		root,
		async [Symbol.asyncDispose]() {
			await rm(root, { force: true, recursive: true })
		},
	}
}

test.each(["root", "client", "array", "named", "implicit"] as const)(
	"MCP View entries preserve Vite's %s input",
	async (scope) => {
		await using project = await createProject({
			"authored.ts": 'globalThis.authoredEntry = "preserved-native-entry"\n',
			"index.html": '<script type="module" src="/authored.ts"></script>',
			"mcp-ui/card/index.html": "<!doctype html><title>Card View</title>",
		})
		const input = join(project.root, "authored.ts")
		const nativeInput =
			scope === "root"
				? { input }
				: scope === "client"
					? { environments: { client: { input } } }
					: scope === "array"
						? { build: { rolldownOptions: { input: [input] } } }
						: scope === "named"
							? { build: { rolldownOptions: { input: { authored: input } } } }
							: {}
		const builder = await createBuilder({
			...nativeInput,
			build: { ...nativeInput.build, write: false },
			configFile: false,
			logLevel: "silent",
			plugins: [mcpApps()],
			root: project.root,
		})

		assert(builder.environments.client)
		const result = await builder.build(builder.environments.client)

		assert(!Array.isArray(result) && "output" in result)
		expect(
			result.output.some(
				(output) =>
					output.type === "chunk" && output.code.includes("preserved-native-entry"),
			),
		).toBe(true)
		expect(result.output.map((output) => output.fileName)).toContain(
			"mcp-ui/card/index.html",
		)
		if (scope === "implicit") {
			expect(result.output.map((output) => output.fileName)).toContain("index.html")
		}
		if (scope === "named") {
			expect(
				result.output.some(
					(output) => output.type === "chunk" && output.name === "authored",
				),
			).toBe(true)
		}
		const manifest = result.output.find((output) => output.fileName === "mcp.json")
		assert(manifest?.type === "asset")
		expect(JSON.parse(String(manifest.source))).toMatchObject({
			resources: [{ name: "card", path: "/mcp-ui/card/", uri: "ui://card/index.html" }],
			tools: [],
		})
	},
)

test("multiple Views share browser modules and CSS while retaining lazy imports", async () => {
	await using project = await createProject({
		"components/card.css": ".shared-view-card { color: rgb(1, 2, 3); }",
		"components/card.tsx": `import * as React from "react"
import { createRoot } from "react-dom/client"
import "./card.css"
function Card({ label }: { label: string }) {
  return <button className="shared-view-card" onClick={async () => {
    const { detail } = await import("./detail")
    document.body.dataset.detail = detail
  }}>{label}</button>
}
export function mount(label: string) {
  createRoot(document.getElementById("root")!).render(<Card label={label} />)
}
`,
		"components/detail.css": ".lazy-detail { color: rgb(4, 5, 6); }",
		"components/detail.ts":
			'import "./detail.css"\nexport const detail = "loaded-lazy-detail"\n',
		"mcp-ui/first/index.html":
			'<!doctype html><div id="root"></div><script type="module" src="./index.ts"></script>',
		"mcp-ui/first/index.ts": `import { mount } from "@/components/card"
mount("first-view")
`,
		"mcp-ui/second/index.html":
			'<!doctype html><div id="root"></div><script type="module" src="./index.ts"></script>',
		"mcp-ui/second/index.ts": `import { mount } from "@/components/card"
mount("second-view")
`,
		"tsconfig.json": JSON.stringify({
			compilerOptions: { paths: { "@/*": ["./*"] } },
			include: ["mcp-ui/**/*", "components/**/*"],
		}),
	})
	const builder = await createBuilder({
		build: { write: false },
		configFile: false,
		logLevel: "silent",
		plugins: [mcpApps()],
		resolve: { tsconfigPaths: true },
		root: project.root,
	})

	assert(builder.environments.client)
	const result = await builder.build(builder.environments.client)

	assert(!Array.isArray(result) && "output" in result)
	const chunks = result.output.filter((output) => output.type === "chunk")
	const stylesheets = result.output
		.filter((output) => output.type === "asset")
		.filter((output) => output.fileName.endsWith(".css"))
	const shared = chunks.filter((chunk) => chunk.code.includes("shared-view-card"))
	expect(shared).toHaveLength(1)
	expect(
		stylesheets.some((output) => String(output.source).includes(".shared-view-card")),
	).toBe(true)
	expect(
		stylesheets.some((output) => String(output.source).includes(".lazy-detail")),
	).toBe(true)
	const lazy = chunks.find((chunk) => chunk.code.includes("loaded-lazy-detail"))
	assert(lazy)
	expect(chunks.some((chunk) => chunk.dynamicImports.includes(lazy.fileName))).toBe(true)
	for (const name of ["first", "second"]) {
		const html = result.output.find(
			(output) => output.fileName === `mcp-ui/${name}/index.html`,
		)
		assert(html?.type === "asset")
		const source = String(html.source)
		const scriptPath = source.match(/<script[^>]*src="([^"]+)"/)?.[1]
		assert(scriptPath)
		expect(chunks.some((chunk) => `/${chunk.fileName}` === scriptPath)).toBe(true)
		expect(source).toMatch(/<link[^>]*rel="stylesheet"/)
	}
	const manifest = result.output.find((output) => output.fileName === "mcp.json")
	assert(manifest?.type === "asset")
	expect(JSON.parse(String(manifest.source))).toMatchObject({
		resources: expect.arrayContaining([
			{
				mimeType: "text/html;profile=mcp-app",
				name: "first",
				path: "/mcp-ui/first/",
				uri: "ui://first/index.html",
			},
			{
				mimeType: "text/html;profile=mcp-app",
				name: "second",
				path: "/mcp-ui/second/",
				uri: "ui://second/index.html",
			},
		]),
		tools: [],
	})
})

test("a tools-only slate emits its catalog without an authored client entry", async () => {
	await using project = await createProject({
		"mcp/echo/index.ts": `import { z } from "zod"
export const tool = {
  name: "echo",
  description: "Echo a number",
  inputSchema: z.object({ value: z.number() }),
}
export function handler({ value }: z.infer<typeof tool.inputSchema>) {
  return { content: [{ type: "text", text: String(value) }] }
}
`,
		"mcp/echo/slate.json": JSON.stringify({
			connections: {},
			databases: {},
			secrets: {},
		}),
	})
	const builder = await createBuilder({
		build: { write: false },
		configFile: false,
		logLevel: "silent",
		plugins: [mcpApps()],
		root: project.root,
	})

	assert(builder.environments.client)
	const result = await builder.build(builder.environments.client)

	assert(!Array.isArray(result) && "output" in result)
	const manifest = result.output.find((output) => output.fileName === "mcp.json")
	assert(manifest?.type === "asset")
	expect(JSON.parse(String(manifest.source))).toMatchObject({
		resources: [],
		tools: [
			{
				declaration: { connections: {}, databases: {}, secrets: {} },
				description: "Echo a number",
				inputSchema: {
					properties: { value: { type: "number" } },
					required: ["value"],
					type: "object",
				},
				name: "echo",
			},
		],
	})
})
