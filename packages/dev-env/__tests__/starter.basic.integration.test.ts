import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execa } from "execa"
import { expect, test } from "vitest"
import { createSlateProject } from "@/slate"

test("the generated starter installs, typechecks, and builds", async () => {
	await using resources = new AsyncDisposableStack()
	const checkout = await mkdtemp(join(tmpdir(), "slate-starter-"))
	resources.defer(() => rm(checkout, { force: true, recursive: true }))
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout, {
		installDependencies: true,
	})
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
}, 180_000)

async function writeViews(checkout: string, withApp: boolean) {
	const files: Record<string, string> = {
		"mcp-ui/shared/message.ts": 'export const message = "shared-slate-browser-code"\n',
		"mcp-ui/shared/view.css": ".slate-view { color: rgb(12, 34, 56) }\n",
	}
	if (withApp) {
		files["components/view-card.tsx"] = `import { message } from "@/mcp-ui/shared/message"
import "@/mcp-ui/shared/view.css"
export function ViewCard({ label }: { label: string }) {
  return <section className="slate-view">{label}: {message}</section>
}
`
		files["app/routes/shared-view.tsx"] =
			`import { ViewCard } from "@/components/view-card"
export default function SharedView() { return <ViewCard label="app" /> }
`
		files["app/routes.ts"] =
			`import { index, route, type RouteConfig } from "@react-router/dev/routes"
export default [index("routes/home.tsx"), route("shared-view", "routes/shared-view.tsx")] satisfies RouteConfig
`
	}
	for (const name of ["first", "second"]) {
		files[`mcp-ui/${name}/index.html`] = `<!doctype html>
<html><head><title>${name}</title></head><body><main id="root"></main>
<script type="module" src="./main.${withApp ? "tsx" : "ts"}"></script>
</body></html>
`
		files[`mcp-ui/${name}/main.${withApp ? "tsx" : "ts"}`] = withApp
			? `import { createRoot } from "react-dom/client"
import { ViewCard } from "@/components/view-card"
createRoot(document.getElementById("root")!).render(<ViewCard label="${name}" />)
`
			: `import { message } from "@/mcp-ui/shared/message"
import "@/mcp-ui/shared/view.css"
document.getElementById("root")!.textContent = "${name}: " + message
`
	}
	for (const [file, source] of Object.entries(files)) {
		await mkdir(dirname(join(checkout, file)), { recursive: true })
		await writeFile(join(checkout, file), source)
	}
}

test.for(["app", "mcp"] as const)(
	"the generated %s project typechecks and builds multiple Views in its native lifecycle",
	{ timeout: 180_000 },
	async (scaffold) => {
		await using resources = new AsyncDisposableStack()
		const checkout = await mkdtemp(join(tmpdir(), `slate-${scaffold}-views-`))
		resources.defer(() => rm(checkout, { force: true, recursive: true }))
		await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout, {
			installDependencies: true,
			scaffold,
		})
		await writeViews(checkout, scaffold === "app")

		await execa("pnpm", ["typecheck"], { cwd: checkout })
		await execa("pnpm", ["build"], { cwd: checkout, env: { NODE_ENV: undefined } })

		const client = join(checkout, "build/client")
		const manifest = JSON.parse(await readFile(join(client, "mcp.json"), "utf8"))
		expect(manifest.resources).toEqual(
			expect.arrayContaining(
				["first", "second"].map((name) => ({
					mimeType: "text/html;profile=mcp-app",
					name,
					path: `/mcp-ui/${name}/`,
					uri: `ui://${name}/index.html`,
				})),
			),
		)
		expect(manifest.resources).toHaveLength(2)
		for (const name of ["first", "second"]) {
			const html = await readFile(join(client, "mcp-ui", name, "index.html"), "utf8")
			const script = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)?.[1]
			const stylesheet = html.match(/<link\b[^>]*\bhref="([^"]+\.css)"/)?.[1]
			for (const asset of [script, stylesheet]) {
				assert(asset, "Each built View references its external JavaScript and CSS")
				const path = new URL(asset, "https://slate.example.com").pathname
				expect(await readFile(join(client, path), "utf8")).not.toBe("")
			}
		}
		if (scaffold === "app") {
			expect(manifest.tools).toEqual([])
			expect(await readFile(join(checkout, "build/server/index.js"), "utf8")).not.toBe("")
		} else {
			expect(await readdir(checkout)).not.toContain("app")
			expect(manifest.tools).toMatchObject([{ name: "tool" }])
			expect(await readFile(join(checkout, "build/ssr/index.js"), "utf8")).not.toBe("")
		}
	},
)
