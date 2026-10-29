import { existsSync } from "node:fs"
import { glob, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { declarationSchema } from "@usecontextlayer/shared/declaration"
import { MCP_MANIFEST_PATH, mcpManifestSchema } from "@usecontextlayer/shared/mcp"
import { build, createServer, createServerModuleRunner, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"
import { z } from "zod"
import type { McpToolModule } from "@/worker"

const clientEntry = "virtual:contextlayer-mcp-assets"
const resolvedClientEntry = `\0${clientEntry}`

export function mcpApps(): Plugin {
	let root: string
	let compiled: ReturnType<typeof compile>

	async function compile() {
		const server = await createServer({
			appType: "custom",
			configFile: false,
			resolve: { tsconfigPaths: true },
			root,
			server: { middlewareMode: true },
		})
		const runner = createServerModuleRunner(server.environments.ssr)
		try {
			const tools = []
			for await (const file of glob("mcp/*/index.ts", { cwd: root })) {
				const { tool } = await runner.import<McpToolModule>(join(root, file))
				const declaration = declarationSchema.parse(
					JSON.parse(await readFile(join(root, dirname(file), "slate.json"), "utf8")),
				)
				if (
					Object.keys(declaration.connections).length ||
					Object.keys(declaration.databases).length ||
					Object.keys(declaration.secrets).length
				) {
					throw new Error(`${file}: MCP resource consumers are not implemented yet`)
				}
				tools.push({
					...tool,
					declaration,
					inputSchema: z.toJSONSchema(tool.inputSchema),
					outputSchema: tool.outputSchema ? z.toJSONSchema(tool.outputSchema) : undefined,
				})
			}
			const assets = []
			const resources = []
			for await (const file of glob("mcp-ui/*/index.html", { cwd: root })) {
				const name = relative("mcp-ui", dirname(file))
				const result = await build({
					build: { rolldownOptions: { input: join(root, file) }, write: false },
					configFile: false,
					plugins: [viteSingleFile()],
					publicDir: false,
					resolve: { tsconfigPaths: true },
					root,
				})
				if (Array.isArray(result) || !("output" in result)) {
					throw new Error("MCP View build must produce one bundle")
				}
				const html = result.output.find(
					(asset) => asset.type === "asset" && asset.fileName.endsWith(".html"),
				)
				if (html?.type !== "asset") throw new Error(`${file}: missing built HTML`)
				const path = `/mcp-ui/${name}`
				assets.push({
					fileName: `${path.slice(1)}.html`,
					source: html.source,
					type: "asset" as const,
				})
				resources.push({
					mimeType: RESOURCE_MIME_TYPE,
					name,
					path,
					uri: `ui://${name}/index.html`,
				})
			}
			const manifest = mcpManifestSchema.parse({ resources, tools })
			assets.push({
				fileName: MCP_MANIFEST_PATH.slice(1),
				source: JSON.stringify(manifest),
				type: "asset" as const,
			})
			return assets
		} finally {
			await runner.close()
			await server.close()
		}
	}

	return {
		config(config) {
			root = resolve(config.root ?? ".")
		},
		configEnvironment: {
			handler(name, config) {
				if (
					name === "client" &&
					config.input === undefined &&
					!config.build?.rolldownOptions?.input &&
					!config.build?.rollupOptions?.input &&
					!existsSync(join(root, "index.html"))
				) {
					return { build: { rolldownOptions: { input: clientEntry } } }
				}
			},
			order: "post",
		},
		configResolved(config) {
			root = config.root
		},
		async generateBundle(_options, bundle) {
			if (this.environment.config.consumer !== "client") return
			compiled ??= compile()
			for (const asset of await compiled) this.emitFile(asset)
			for (const [fileName, output] of Object.entries(bundle)) {
				if (output.type === "chunk" && output.facadeModuleId === resolvedClientEntry) {
					delete bundle[fileName]
				}
			}
		},
		load(id) {
			if (id === resolvedClientEntry) return "export {}"
		},
		name: "contextlayer-mcp-apps",
		resolveId(id) {
			if (id === clientEntry) return resolvedClientEntry
		},
	}
}
