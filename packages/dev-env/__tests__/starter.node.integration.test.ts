import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execa } from "execa"
import { expect, test } from "vitest"
import { createSlateProject } from "@/slate"

async function addViews(checkout: string, react: boolean) {
	const files: Record<string, string> = {
		"mcp-ui/shared/lazy.css": ".lazy-view { font-weight: bold }\n",
		"mcp-ui/shared/lazy.ts":
			'import "./lazy.css"\nexport const message = "mcp-lazy-browser-module"\n',
		"mcp-ui/shared/message.ts": 'export const message = "mcp-shared-browser-module"\n',
		"mcp-ui/shared/shared.css": ".shared-view { color: rgb(12, 34, 56) }\n",
	}
	if (react) {
		files["mcp-ui/shared/card.tsx"] = `import { message } from "@/mcp-ui/shared/message"
import "@/mcp-ui/shared/shared.css"
export function ViewCard({ label }: { label: string }) {
  return <section className="shared-view">{label}: {message}</section>
}
`
		const root = join(checkout, "app/root.tsx")
		await writeFile(
			root,
			`import { ViewCard } from "@/mcp-ui/shared/card"\n${await readFile(root, "utf8")}`.replace(
				"return <Outlet />",
				'return <><ViewCard label="app" /><Outlet /></>',
			),
		)
	}
	for (const name of ["first", "second"]) {
		files[`mcp-ui/${name}/index.html`] = `<!doctype html>
<html><head><title>${name}</title></head><body>
<main id="root" class="shared-view"></main><button id="lazy">Load</button><output id="result"></output>
<script type="module" src="./main.${react ? "tsx" : "ts"}"></script>
</body></html>
`
		files[`mcp-ui/${name}/main.${react ? "tsx" : "ts"}`] = `${
			react
				? `import { createRoot } from "react-dom/client"
import { ViewCard } from "@/mcp-ui/shared/card"
createRoot(document.getElementById("root")!).render(<ViewCard label="${name}" />)`
				: `import { message } from "@/mcp-ui/shared/message"
import "@/mcp-ui/shared/shared.css"
document.getElementById("root")!.textContent = "${name}: " + message`
		}
document.getElementById("lazy")!.addEventListener("click", async () => {
  const { message } = await import("@/mcp-ui/shared/lazy")
  document.getElementById("result")!.textContent = message
})
`
	}
	await Promise.all(
		Object.entries(files).map(async ([file, source]) => {
			await mkdir(dirname(join(checkout, file)), { recursive: true })
			await writeFile(join(checkout, file), source)
		}),
	)
}

async function verifyViews(checkout: string) {
	const client = join(checkout, "build/client")
	const manifest = JSON.parse(await readFile(join(client, "mcp.json"), "utf8"))
	expect(manifest.resources).toHaveLength(2)
	for (const name of ["first", "second"]) {
		expect(manifest.resources).toContainEqual({
			mimeType: "text/html;profile=mcp-app",
			name,
			path: `/mcp-ui/${name}/`,
			uri: `ui://${name}/index.html`,
		})
		const html = await readFile(join(client, "mcp-ui", name, "index.html"), "utf8")
		const script = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)
		const stylesheet = html.match(/<link\b[^>]*\bhref="([^"]+\.css)"/)
		for (const asset of [script?.[1], stylesheet?.[1]]) {
			assert(asset, "Each built View must reference external JavaScript and CSS")
			const path = new URL(asset, "https://slate.example.com").pathname
			expect(await readFile(join(client, path), "utf8")).not.toBe("")
		}
	}
	const assets = await readdir(join(client, "assets"))
	const javascript = (
		await Promise.all(
			assets
				.filter((file) => file.endsWith(".js"))
				.map((file) => readFile(join(client, "assets", file), "utf8")),
		)
	).join("\n")
	const css = (
		await Promise.all(
			assets
				.filter((file) => file.endsWith(".css"))
				.map((file) => readFile(join(client, "assets", file), "utf8")),
		)
	).join("\n")
	expect(javascript).toContain("mcp-shared-browser-module")
	expect(javascript).toContain("mcp-lazy-browser-module")
	expect(javascript).toContain("import(")
	expect(css).toContain(".shared-view")
	expect(css).toContain(".lazy-view")
	return { javascript, manifest }
}

test("the generated app starter typechecks and builds alongside multiple Views", async () => {
	await using resources = new AsyncDisposableStack()
	const checkout = await mkdtemp(join(tmpdir(), "slate-starter-"))
	resources.defer(() => rm(checkout, { force: true, recursive: true }))
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout, {
		installDependencies: true,
	})
	await addViews(checkout, true)
	const help = await execa("pnpm", ["exec", "ctx", "ci", "slate.example.com", "--help"], {
		cwd: checkout,
		env: {
			CTX_AUTH_CLIENT_ID: "help-only",
			CTX_AUTH_ISSUER: "http://localhost:1/api/auth",
			CTX_CONFIG_DIR: join(checkout, ".contextlayer/cli"),
			CTX_PLATFORM_URL: "http://localhost:1",
		},
	})
	expect(help.stdout).toContain("Workflow instance operations")
	await execa("pnpm", ["typecheck"], { cwd: checkout })
	await execa("pnpm", ["build"], { cwd: checkout, env: { NODE_ENV: undefined } })
	const { javascript, manifest } = await verifyViews(checkout)
	expect(javascript).toContain("A shared notebook for your slate.")
	expect(manifest.tools).toEqual([])
	expect(await readFile(join(checkout, "build/server/index.js"), "utf8")).not.toBe("")
}, 180_000)

test("the generated MCP-only starter typechecks and builds multiple Views without an app", async () => {
	await using resources = new AsyncDisposableStack()
	const checkout = await mkdtemp(join(tmpdir(), "slate-mcp-starter-"))
	resources.defer(() => rm(checkout, { force: true, recursive: true }))
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout, {
		installDependencies: true,
		scaffold: "mcp",
	})
	await addViews(checkout, false)
	await writeFile(
		join(checkout, "mcp/tool/index.ts"),
		`import { z } from "zod"
export const tool = {
  description: "Echo a number.",
  inputSchema: z.object({ value: z.number() }),
  name: "tool",
}
export function handler({ value }: z.infer<typeof tool.inputSchema>) {
  return { content: [{ text: String(value), type: "text" as const }] }
}
`,
	)
	await execa("pnpm", ["typecheck"], { cwd: checkout })
	await execa("pnpm", ["build"], { cwd: checkout, env: { NODE_ENV: undefined } })

	expect(await readdir(checkout)).not.toContain("app")
	expect(await readFile(join(checkout, "build/server/index.js"), "utf8")).not.toBe("")
	const { manifest } = await verifyViews(checkout)
	expect(manifest.tools).toEqual([
		{
			declaration: { connections: {}, databases: {}, secrets: {} },
			description: "Echo a number.",
			inputSchema: expect.any(Object),
			name: "tool",
		},
	])
	await expect(readFile(join(checkout, "build/client/slate.json"))).rejects.toMatchObject(
		{
			code: "ENOENT",
		},
	)
}, 180_000)
