import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuilder } from "vite"
import { expect, test } from "vitest"
import { mcpApps } from "@/mcp-vite"

test.each(["root", "client"] as const)(
	"MCP assets preserve Vite's native %s input",
	async (scope) => {
		await using resources = new AsyncDisposableStack()
		const root = await mkdtemp(join(tmpdir(), "sdk-mcp-native-input-"))
		resources.defer(() => rm(root, { force: true, recursive: true }))
		const input = join(root, "authored.ts")
		await writeFile(input, 'globalThis.authoredEntry = "preserved-native-entry"\n')
		const builder = await createBuilder({
			build: { write: false },
			configFile: false,
			...(scope === "root" ? { input } : { environments: { client: { input } } }),
			logLevel: "silent",
			plugins: [mcpApps()],
			root,
		})

		assert(builder.environments.client)
		const result = await builder.build(builder.environments.client)

		if (Array.isArray(result) || !("output" in result)) {
			throw new Error("Expected a single client bundle")
		}
		expect(
			result.output.some(
				(output) =>
					output.type === "chunk" && output.code.includes("preserved-native-entry"),
			),
		).toBe(true)
		expect(result.output.some((output) => output.fileName === "mcp.json")).toBe(true)
	},
)
