import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { test as base, expect } from "vitest"
import { slateDeploymentConfig } from "@/deployment"

const execFile = promisify(execFileCallback)
const wrangler = join(import.meta.dirname, "node_modules/.bin/wrangler")
const test = base.extend<{ directory: string }>({
	// biome-ignore lint/correctness/noEmptyPattern: Vitest discovers fixture dependencies by destructuring.
	directory: async ({}, use) => {
		const directory = await mkdtemp(join(tmpdir(), "slate-artifact-"))
		try {
			await use(directory)
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	},
})

test("publishes compiled modules and assets with platform-owned configuration", async ({
	directory,
}) => {
	const output = join(directory, "deploy")
	const source = join(output, "payload")
	await mkdir(join(source, "server/assets"), { recursive: true })
	await mkdir(join(source, "client"), { recursive: true })
	await writeFile(
		join(source, "server/index.js"),
		'import { value } from "./assets/chunk.js"; throw new Error("AUTHOR_MODULE_EXECUTED"); export default { fetch() { return new Response(value) } };',
	)
	await writeFile(join(source, "server/assets/chunk.js"), 'export const value = "slate";')
	await writeFile(join(source, "client/index.html"), "<p>slate assets</p>")
	await writeFile(
		join(source, "server/wrangler.json"),
		JSON.stringify({
			build: { command: "echo AUTHOR_BUILD_EXECUTED; exit 1" },
			name: "author-selected-name",
			vars: { DANGEROUS: "author binding" },
		}),
	)
	await writeFile(join(source, ".env"), "CLOUDFLARE_ENV=author-selected-environment")
	await writeFile(join(directory, "outside.json"), "OUTSIDE_PAYLOAD_SENTINEL")
	await writeFile(
		join(source, "server/tsconfig.json"),
		JSON.stringify({ extends: join(directory, "outside.json") }),
	)
	await writeFile(join(source, "server/package.json"), '{"type":"commonjs"}')
	await writeFile(join(output, "tsconfig.json"), "{}")
	await writeFile(
		join(output, "wrangler.json"),
		JSON.stringify(slateDeploymentConfig("trusted-slate")),
	)

	const { stderr } = await execFile(
		wrangler,
		[
			"deploy",
			"--config",
			"wrangler.json",
			"--no-bundle",
			"--dry-run",
			"--outfile",
			join(directory, "worker.bundle"),
			"--dispatch-namespace",
			"test",
		],
		{
			cwd: output,
			env: {
				CI: "true",
				PATH: process.env.PATH,
				WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
				WRANGLER_SEND_METRICS: "false",
			},
		},
	)
	expect(stderr).not.toContain("author-selected-environment")
	const bundle = await readFile(join(directory, "worker.bundle"))
	const boundary = bundle.toString().split("\r\n", 1)[0].slice(2)
	const upload = await new Response(new Uint8Array(bundle), {
		headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
	}).formData()
	const metadata = JSON.parse(String(upload.get("metadata")))
	expect(metadata.bindings).toEqual([{ name: "ASSETS", type: "assets" }])
	expect(upload.has("assets/chunk.js")).toBe(true)
}, 30_000)
