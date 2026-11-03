import { existsSync } from "node:fs"
import { glob, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { declarationSchema } from "@usecontextlayer/shared/declaration"
import { MCP_MANIFEST_PATH, mcpManifestSchema } from "@usecontextlayer/shared/mcp"
import { createServer, createServerModuleRunner, type Plugin } from "vite"
import { z } from "zod"
import type { McpToolModule } from "@/worker"

const clientEntry = "virtual:contextlayer-mcp-assets"
const resolvedClientEntry = `\0${clientEntry}`

export function mcpApps(): Plugin {
	let root: string
	let views: string[]
	let compiled: ReturnType<typeof compileManifest>

	async function compileManifest() {
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
			const resources = views.map((file) => {
				const name = relative("mcp-ui", dirname(file))
				return {
					mimeType: RESOURCE_MIME_TYPE,
					name,
					path: `/${dirname(file)}/`,
					uri: `ui://${name}/index.html`,
				}
			})
			return mcpManifestSchema.parse({ resources, tools })
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
			async handler(name, config) {
				if (name !== "client") return
				views = []
				for await (const file of glob("mcp-ui/*/index.html", { cwd: root }))
					views.push(file)
				const entries = [clientEntry, ...views.map((file) => resolve(root, file))]
				config.build ??= {}
				config.build.rolldownOptions ??= {}
				const options = config.build.rolldownOptions
				// Cloudflare decides whether to build the client from the bundler input.
				options.input ??= config.input
				if (!options.input && existsSync(join(root, "index.html"))) {
					options.input = join(root, "index.html")
				}
				const input =
					typeof options.input === "object" && !Array.isArray(options.input)
						? Object.fromEntries(
								entries.map((entry) => [
									entry === clientEntry
										? "contextlayer-mcp-assets"
										: relative(root, entry),
									entry,
								]),
							)
						: entries
				return { build: { rolldownOptions: { input } } }
			},
			order: "post",
		},
		configResolved(config) {
			root = config.root
		},
		async generateBundle(_options, bundle) {
			if (this.environment.config.consumer !== "client") return
			compiled ??= compileManifest()
			this.emitFile({
				fileName: MCP_MANIFEST_PATH.slice(1),
				source: JSON.stringify(await compiled),
				type: "asset",
			})
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
