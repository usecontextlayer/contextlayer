import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

test("the generated MCP-only starter installs, typechecks, and builds without an app", async () => {
	await using resources = new AsyncDisposableStack()
	const checkout = await mkdtemp(join(tmpdir(), "slate-mcp-starter-"))
	resources.defer(() => rm(checkout, { force: true, recursive: true }))
	await createSlateProject(resolve(import.meta.dirname, "../../.."), checkout, {
		installDependencies: true,
		scaffold: "mcp",
	})
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
	const manifest = JSON.parse(
		await readFile(join(checkout, "build/client/mcp.json"), "utf8"),
	)
	expect(manifest).toMatchObject({
		resources: [],
		tools: [
			{ declaration: { connections: {}, databases: {}, secrets: {} }, name: "tool" },
		],
	})
	await expect(readFile(join(checkout, "build/client/slate.json"))).rejects.toMatchObject(
		{
			code: "ENOENT",
		},
	)
}, 180_000)
